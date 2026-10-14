// Fake herdr socket server for offline testing of herdr-ompg-bridge.
//
// Listens on a named pipe (Windows) or unix socket, prints every JSON Lines
// request it receives, and answers with a minimal success response.
//
// Env knobs:
//   FAKE_PIPE_NAME   pipe/socket name (default: herdr-bridge-test)
//   FAKE_FAIL_FIRST  accept-but-never-respond to the first N requests
//                    (simulates a dead herdr so the bridge's resync
//                    backoff and recovery can be observed)
//
// Usage: node test/fake-herdr-server.mjs
// Stop with Ctrl+C.

import net from "node:net";

const pipeName = process.env.FAKE_PIPE_NAME ?? "herdr-bridge-test";
const failFirst = Number.parseInt(process.env.FAKE_FAIL_FIRST ?? "0", 10) || 0;
const isWin = process.platform === "win32";
const endpoint = isWin ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;

let received = 0;

const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            received++;
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch {
                parsed = { raw: line };
            }
            const ts = new Date().toISOString().slice(11, 23);
            console.log(`[${ts}] #${received} ${parsed.method ?? "?"} ${JSON.stringify(parsed.params)}`);
            if (received <= failFirst) {
                console.log(`[${ts}]   -> swallowing response (simulated dead server, ${failFirst - received} more)`);
            } else {
                socket.write(JSON.stringify({ id: parsed.id ?? null, result: { ok: true } }) + "\n");
            }
        }
    });
    socket.on("error", () => { /* client hung up mid-request */ });
});

server.on("error", err => {
    console.error(`server error: ${err.message}`);
    process.exit(1);
});

server.listen(endpoint, () => {
    console.log(`fake herdr server listening on ${endpoint}`);
    console.log(`fail-first: ${failFirst}   Ctrl+C to stop`);
});
