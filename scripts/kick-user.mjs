import 'dotenv/config';
import WebSocket from 'ws';

const ws = new WebSocket(process.env.NAPCAT_WS_URL, {
  headers: { Authorization: `Bearer ${process.env.NAPCAT_ACCESS_TOKEN}` },
});

const GROUP_ID = 958751334;
const USER_ID = 3461314664;

let echoCounter = 0;
const pending = new Map();

function action(name, params) {
  return new Promise((resolve, reject) => {
    const echo = String(++echoCounter);
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action: name, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error(`${name} timed out`));
      }
    }, 10000);
  });
}

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.echo && pending.has(msg.echo)) {
      const p = pending.get(msg.echo);
      pending.delete(msg.echo);
      if (msg.status === 'ok') p.resolve(msg);
      else p.reject(new Error(`retcode=${msg.retcode}`));
    }
  } catch {}
});

ws.on('open', async () => {
  console.log('connected');
  try {
    const res = await action('set_group_kick', {
      group_id: GROUP_ID,
      user_id: USER_ID,
      reject_add_request: true,
    });
    console.log('kick result:', JSON.stringify(res));
  } catch (e) {
    console.error('kick failed:', e.message);
  } finally {
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(1);
});
