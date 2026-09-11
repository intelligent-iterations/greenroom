/**
 * Collects eval results from the browser.
 *
 * The in-browser runner produces numbers the offline harness cannot: it scores
 * the on-device model, which is the one that ships. Getting those numbers out
 * of the page reliably matters more than it sounds — reading them through a
 * debugger connection lost a completed run twice — so the page POSTs them here
 * and they land on disk next to the offline reports.
 */
import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const PORT = Number(process.env.PORT ?? 5185);
const OUT = new URL('../../../evals/reports/on-device-latest.json', import.meta.url).pathname;

const server = createServer(async (req, res) => {
  // The runner is served from a different port, so it is cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (req.method !== 'POST') return void res.writeHead(405).end('POST only');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, body, 'utf8');

  // One line per report so a stalled run is visible from the shell.
  let note = `${body.length} bytes`;
  try {
    const parsed = JSON.parse(body);
    note = `stage=${parsed.stage} progress=${parsed.progress ?? '-'}${parsed.error ? ' ERROR=' + parsed.error : ''}`;
  } catch {
    // Not JSON; the byte count is still useful.
  }
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${note}`);

  res.writeHead(200).end('ok');
});

server.listen(PORT, () => console.log(`collector listening on :${PORT}`));
