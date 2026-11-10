import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { env } from './config/env';

async function main() {
  const { app } = await createApp();
  await app.listen(env().API_PORT);
  const log = new Logger('Bootstrap');
  log.log(`API em http://localhost:${env().API_PORT}/api/v1  •  OpenAPI: http://localhost:${env().API_PORT}/api/docs`);
}

main().catch((err) => {
  console.error('Falha ao iniciar a API:', err);
  process.exit(1);
});
