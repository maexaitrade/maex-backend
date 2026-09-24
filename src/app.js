const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/error');

const app = express();

app.use(cors());
// Capture raw body for webhook HMAC verification before JSON parser consumes the stream
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'maex-trade' }));
app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
