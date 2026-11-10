/** Gera docs/openapi.json a partir dos controladores (npm run openapi -w @lsg/api). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './bootstrap';

async function run() {
  const { app, openapi } = await createApp({ logger: false });
  const out = join(__dirname, '..', '..', '..', 'docs', 'openapi.json');
  writeFileSync(out, JSON.stringify(openapi, null, 2));
  await app.close();
  console.log(`✔ OpenAPI gerado em ${out}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
