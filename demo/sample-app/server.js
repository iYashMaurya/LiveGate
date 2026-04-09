import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SIMULATE_SLOW = process.env.SIMULATE_SLOW === 'true';

const fakeOrders = [
  { id: 1001, user_id: 42, status: 'pending', total: 59.99, priority: 'normal', created_at: '2025-04-09T10:00:00Z' },
  { id: 1002, user_id: 17, status: 'pending', total: 124.50, priority: 'high', created_at: '2025-04-09T11:30:00Z' },
  { id: 1003, user_id: 42, status: 'completed', total: 89.00, priority: 'normal', created_at: '2025-04-08T09:15:00Z' },
];

let nextId = 2000;

// GET /api/orders
app.get('/api/orders', async (req, res) => {
  const delay = SIMULATE_SLOW ? 450 : 120;
  await new Promise(r => setTimeout(r, delay));

  let result = [...fakeOrders];
  if (req.query.status) {
    result = result.filter(o => o.status === req.query.status);
  }
  const limit = parseInt(req.query.limit) || 100;
  result = result.slice(0, limit);
  res.json(result);
});

// GET /api/orders/:id
app.get('/api/orders/:id', (req, res) => {
  const order = fakeOrders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// POST /api/orders
app.post('/api/orders', (req, res) => {
  const order = {
    id: nextId++,
    user_id: req.body.user_id || 1,
    status: 'pending',
    total: req.body.total || 0,
    priority: req.body.priority || 'normal',
    created_at: new Date().toISOString(),
  };
  fakeOrders.push(order);
  res.status(201).json(order);
});

// GET /api/users/:id/orders
app.get('/api/users/:id/orders', (req, res) => {
  const userId = parseInt(req.params.id);
  const orders = fakeOrders.filter(o => o.user_id === userId);
  res.json(orders);
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Demo app listening on http://localhost:${PORT}`);
  if (SIMULATE_SLOW) console.log('⚠ SIMULATE_SLOW=true — GET /api/orders has 450ms latency');
});
