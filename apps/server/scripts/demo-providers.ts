/**
 * Local stand-ins for Evolution Go (:4010) and Chatwoot (:4020), for trying the dashboard and
 * for Playwright. Not used in production. Run EvoBridge with ALLOW_PRIVATE_NETWORKS=true.
 *
 *   pnpm --filter @evobridge/server demo:providers
 *   curl -X POST localhost:4010/__demo/incoming -d '{"text":"Oi!"}' -H 'content-type: application/json'
 *   curl -X POST localhost:4020/__demo/reply -d '{"text":"Olá"}' -H 'content-type: application/json'
 */
import { FakeChatwoot } from '../test/mocks/chatwoot.js';
import { FakeEvolutionGo } from '../test/mocks/evolution-go.js';

const evo = new FakeEvolutionGo();
const cw = new FakeChatwoot();
evo.addInstance({ name: 'loja', jid: '5511900000001:7@s.whatsapp.net' });
evo.addInstance({ name: 'suporte', jid: '5511900000002:3@s.whatsapp.net', connected: false });
cw.addInbox('Website', 'Channel::WebWidget');

let n = 0;
evo.app.post<{ Body: { text?: string; from?: string; instance?: string } }>('/__demo/incoming', async (req) => {
  const inst = evo.instances.find((i) => i.name === (req.body?.instance ?? 'loja'))!;
  const status = await evo.emit(inst, evo.incomingText(inst, { id: `DEMO${Date.now()}${n++}`, from: req.body?.from ?? '5511987654321', text: req.body?.text ?? 'Oi, tudo bem?', pushName: 'Maria Souza' }));
  return { delivered: status };
});
cw.app.post<{ Body: { text?: string } }>('/__demo/reply', async (req) => {
  const conv = cw.conversations.at(-1);
  if (!conv) return { error: 'no conversation yet' };
  await cw.agentReply(conv.id, req.body?.text ?? 'Olá! Como posso ajudar?');
  return { ok: true, sentToWhatsApp: evo.sent.length };
});
cw.app.get('/__demo/state', async () => ({ contacts: cw.contacts, conversations: cw.conversations, messages: cw.messages }));
evo.app.get('/__demo/state', async () => ({ instances: evo.instances, sent: evo.sent }));

await evo.start(Number(process.env.EVO_PORT ?? 4010));
await cw.start(Number(process.env.CW_PORT ?? 4020));
console.log(`Fake Evolution Go: ${evo.url}  (global key: ${evo.globalKey})`);
console.log(`Fake Chatwoot:     ${cw.url}  (token: admin-token)`);
