// A stand-in MCP server over stdio for tests (run with node). It offers brave_web_search and
// brave_image_search, pings the client once after initialize, and reports which env vars it got.
import readline from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });

  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-search', version: '1.0.0' } });
  }
  if (msg.method === 'notifications/initialized') {
    return send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' });
  }
  if (msg.method === 'tools/list') {
    return reply({
      tools: [
        {
          name: 'brave_web_search',
          description: 'Search the web with Brave.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search terms' }, count: { type: 'number' }, freshness: { type: 'string' } },
            required: ['query'],
          },
        },
        { name: 'brave_image_search', description: 'Search images.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      ],
    });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name !== 'brave_web_search') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } });
    if (args.query === 'fail please') return reply({ isError: true, content: [{ type: 'text', text: 'Rate limited' }] });
    return reply({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            key: process.env.MOCK_KEY ? 'set' : 'missing',
            leaked: process.env.TREASURY_PRIVATE_KEY ? 'yes' : 'no',
            results: [
              { title: 'Export schedules', url: 'https://help.autodesk.com/view/RVT/2027/ENU/?guid=export', description: 'File > Export > Reports > Schedule.' },
              { title: 'Same site again', url: 'https://help.autodesk.com/other' },
              { title: 'Forum', url: 'https://forums.autodesk.com/t5/revit/export-schedule/td-p/1' },
            ],
          }),
        },
      ],
    });
  }
  if (msg.id === 'srv-1' && 'result' in msg) {
    process.stderr.write('ping answered\n');
    return undefined;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  return undefined;
});
