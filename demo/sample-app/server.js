import express from 'express';

// OpenTelemetry instrumentation (only if OTEL_EXPORTER_OTLP_ENDPOINT is set)
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = await import('@opentelemetry/instrumentation-express');

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
      }),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
      ],
      serviceName: process.env.OTEL_SERVICE_NAME || 'livegate-demo-app',
    });
    sdk.start();
    console.log('✓ OpenTelemetry initialized');
  } catch (err) {
    console.log(`⚠ OTel init skipped: ${err.message}`);
  }
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SIMULATE_SLOW = process.env.SIMULATE_SLOW === 'true';
const BUG_MODE = process.env.BUG_MODE === 'true';

const fakeOrders = [
  { id: 1, user_id: 1, status: 'pending',   total: 29.99, priority: 'high',   created_at: '2025-04-09T10:00:00Z' },
  { id: 2, user_id: 1, status: 'shipped',   total: 59.99, priority: 'normal', created_at: '2025-04-09T11:30:00Z' },
  { id: 3, user_id: 2, status: 'delivered', total: 19.99, priority: 'low',    created_at: '2025-04-08T09:15:00Z' },
  { id: 4, user_id: 2, status: 'pending',   total: 89.99, priority: 'high',   created_at: '2025-04-08T14:00:00Z' },
  { id: 5, user_id: 3, status: 'cancelled', total: 39.99, priority: 'normal', created_at: '2025-04-07T16:30:00Z' },
];

let nextId = 2000;

// GET /api/orders
app.get('/api/orders', async (req, res) => {
  const delay = SIMULATE_SLOW ? 800 : 120;
  await new Promise(r => setTimeout(r, delay));

  let result = [...fakeOrders];
  if (req.query.status) {
    result = result.filter(o => o.status === req.query.status);
  }
  if (req.query.priority) {
    if (BUG_MODE) {
      // BUG: uses > instead of === — misses exact priority matches
      result = result.filter(o => o.priority > req.query.priority);
    } else {
      result = result.filter(o => o.priority === req.query.priority);
    }
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

// GET /api/orders/search?q=keyword
app.get('/api/orders/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing q parameter' });

  // BUG: case-sensitive search — "Pending" won't match "pending"
  const results = fakeOrders.filter(o =>
    o.status.includes(query) || o.priority.includes(query)
  );
  res.json({ query, results, count: results.length });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Demo app listening on http://localhost:${PORT}`);
  if (SIMULATE_SLOW) console.log('⚠ SIMULATE_SLOW=true — GET /api/orders has 800ms latency');
  if (BUG_MODE) console.log('⚠ BUG_MODE=true — priority filter has off-by-one bug');
});
