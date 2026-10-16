import { createApp } from './app.js';

const app = createApp({ origin: process.env.ALLOWED_ORIGIN ?? '*' });
const port = Number(process.env.PORT) || 3001;

void app.listen(port).then((p) => console.log(`watch-together server on :${p} (origin: ${app.config.origin})`));

const shutdown = () => void app.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
