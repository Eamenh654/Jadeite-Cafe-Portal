const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./db');
require('./seeds');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PATCH', 'DELETE']
    }
});

// Ensure upload dir exists
const uploadDir = path.join(__dirname, 'data/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

app.get('/api/version', (req, res) => res.json({ version: '1.0.1' }));

// Multer Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// --- Image Upload ---
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    // Infer the correct host and protocol dynamically from headers first
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3001';
    const dynamicBaseUrl = `${protocol}://${host}`;
    
    const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || dynamicBaseUrl;
    const cleanBaseUrl = baseUrl.replace(/\/+$/, ''); // Ensure no trailing slash
    
    const imageUrl = `${cleanBaseUrl}/uploads/${req.file.filename}`;
    res.json({ imageUrl });
});

const JWT_SECRET = process.env.JWT_SECRET || 'maison-super-secret-key';

// --- Auth Routes ---
app.post('/api/register', (req, res) => {
    const { username, password, role, location } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: 'Missing fields' });

    const hashedPassword = bcrypt.hashSync(password, 10);
    try {
        const stmt = db.prepare('INSERT INTO users (username, password, role, location) VALUES (?, ?, ?, ?)');
        const info = stmt.run(username, hashedPassword, role, location);
        const token = jwt.sign({ id: info.lastInsertRowid, role, username }, JWT_SECRET);
        res.json({ token, user: { id: info.lastInsertRowid, username, role, location } });
    } catch (err) {
        res.status(400).json({ error: 'Username already exists' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, location: user.location } });
});

// --- Menu Routes ---
app.get('/api/products', (req, res) => {
    const products = db.prepare('SELECT * FROM products').all();
    const productsWithVariants = products.map(p => {
        const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(p.id);
        const variantsWithOptions = variants.map(v => {
            const options = db.prepare('SELECT * FROM variant_options WHERE variant_id = ?').all(v.id);
            return { ...v, options };
        });
        return { ...p, variants: variantsWithOptions };
    });
    res.json(productsWithVariants);
});

// Admin: Add Product
app.post('/api/products', (req, res) => {
    const { name, category, description, icon, image_url } = req.body;
    const info = db.prepare('INSERT INTO products (name, category, description, icon, image_url) VALUES (?, ?, ?, ?, ?)').run(name, category, description, icon, image_url);
    res.json({ id: info.lastInsertRowid });
});

// Admin: Delete Product
app.delete('/api/products/:id', (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// Admin: Add Variant
app.post('/api/products/:id/variants', (req, res) => {
    const { name, options } = req.body; // options: ['Small', 'Large']
    const info = db.prepare('INSERT INTO product_variants (product_id, name) VALUES (?, ?)').run(req.params.id, name);
    const variantId = info.lastInsertRowid;

    for (const opt of options) {
        db.prepare('INSERT INTO variant_options (variant_id, name, is_default) VALUES (?, ?, ?)').run(variantId, opt, 0);
    }
    res.json({ success: true });
});

app.patch('/api/variants/:id', (req, res) => {
    db.prepare('UPDATE product_variants SET name = ? WHERE id = ?').run(req.body.name, req.params.id);
    res.json({ success: true });
});

app.delete('/api/variants/:id', (req, res) => {
    db.prepare('DELETE FROM variant_options WHERE variant_id = ?').run(req.params.id);
    db.prepare('DELETE FROM product_variants WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.patch('/api/options/:id', (req, res) => {
    db.prepare('UPDATE variant_options SET name = ? WHERE id = ?').run(req.body.name, req.params.id);
    res.json({ success: true });
});

app.delete('/api/options/:id', (req, res) => {
    db.prepare('DELETE FROM variant_options WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.post('/api/variants/:id/options', (req, res) => {
    const { name } = req.body;
    db.prepare('INSERT INTO variant_options (variant_id, name) VALUES (?, ?)').run(req.params.id, name);
    res.json({ success: true });
});

app.patch('/api/products/:id/toggle', (req, res) => {
    const { id } = req.params;
    const product = db.prepare('SELECT is_available FROM products WHERE id = ?').get(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const newVal = product.is_available ? 0 : 1;
    db.prepare('UPDATE products SET is_available = ? WHERE id = ?').run(newVal, id);
    res.json({ success: true, is_available: newVal });
});

app.patch('/api/products/:id/image', (req, res) => {
    const { id } = req.params;
    const { image_url } = req.body;
    db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(image_url, id);
    res.json({ success: true, image_url });
});

// --- Category Routes ---
// Seed default categories if none exist
const defaultCats = [
    { name: 'coffee', icon: '☕' },
    { name: 'tea', icon: '🍃' },
    { name: 'water', icon: '💧' },
    { name: 'refreshments', icon: '🍪' }
];
const existingCats = db.prepare('SELECT count(*) as count FROM categories').get();
if (existingCats.count === 0) {
    for (const cat of defaultCats) {
        db.prepare('INSERT INTO categories (name, icon) VALUES (?, ?)').run(cat.name, cat.icon);
    }
}

app.get('/api/categories', (req, res) => {
    const cats = db.prepare('SELECT * FROM categories').all();
    res.json(cats);
});

app.post('/api/categories', (req, res) => {
    const { name, icon } = req.body;
    try {
        const info = db.prepare('INSERT INTO categories (name, icon) VALUES (?, ?)').run(name, icon || '🥤');
        res.json({ id: info.lastInsertRowid, name, icon: icon || '🥤' });
    } catch (err) {
        res.status(400).json({ error: 'Category already exists' });
    }
});

app.delete('/api/categories/:id', (req, res) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// --- Order Routes ---
app.post('/api/orders', (req, res) => {
    const { userId, items } = req.body; 
    
    const info = db.prepare('INSERT INTO orders (user_id, status) VALUES (?, ?)').run(userId, 'pending');
    const orderId = info.lastInsertRowid;

    for (const item of items) {
        const itemInfo = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, special_instructions) VALUES (?, ?, ?, ?)').run(orderId, item.productId, item.quantity || 1, item.instructions || '');
        const orderItemId = itemInfo.lastInsertRowid;

        if (item.selections) {
            for (const [vName, oName] of Object.entries(item.selections)) {
                db.prepare('INSERT INTO order_item_selections (order_item_id, variant_name, option_name) VALUES (?, ?, ?)').run(orderItemId, vName, oName);
            }
        }
    }

    const fullOrder = getFullOrder(orderId);
    io.emit('order:new', fullOrder);
    res.json({ success: true, orderId });
});

app.get('/api/orders/active', (req, res) => {
    const orders = db.prepare("SELECT id FROM orders WHERE status != 'delivered' AND status != 'declined'").all();
    const fullOrders = orders.map(o => getFullOrder(o.id));
    res.json(fullOrders);
});

app.get('/api/orders/completed', (req, res) => {
    const orders = db.prepare("SELECT id FROM orders WHERE status = 'delivered' ORDER BY created_at DESC LIMIT 15").all();
    const fullOrders = orders.map(o => getFullOrder(o.id));
    res.json(fullOrders);
});

app.get('/api/orders/user/:userId', (req, res) => {
    const orders = db.prepare("SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").all(req.params.userId);
    const fullOrders = orders.map(o => getFullOrder(o.id));
    res.json(fullOrders);
});

app.get('/api/orders/user/:userId/history', (req, res) => {
    const orders = db.prepare("SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(req.params.userId);
    const fullOrders = orders.map(o => getFullOrder(o.id));
    res.json(fullOrders);
});

app.patch('/api/orders/:id/status', (req, res) => {
    const { status } = req.body;
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
    
    const updatedOrder = getFullOrder(req.params.id);
    io.emit('order:status-changed', updatedOrder);
    res.json({ success: true });
});

function getFullOrder(orderId) {
    const order = db.prepare(`
        SELECT orders.*, users.username, users.location 
        FROM orders 
        JOIN users ON orders.user_id = users.id 
        WHERE orders.id = ?
    `).get(orderId);
    
    if (!order) return null;

    const items = db.prepare(`
        SELECT order_items.*, products.name as product_name, products.icon as product_icon
        FROM order_items 
        JOIN products ON order_items.product_id = products.id 
        WHERE order_items.order_id = ?
    `).all(orderId);

    for (const item of items) {
        item.selections = db.prepare('SELECT variant_name, option_name FROM order_item_selections WHERE order_item_id = ?').all(item.id);
    }

    order.items = items;
    return order;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
