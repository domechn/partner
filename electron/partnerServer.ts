/**
 * Manages the lifecycle of the Python Partner server subprocess.
 *
 * The server is spawned with `uv run python server.py` from the `python/`
 * directory. Startup is detected by watching stdout/stderr for uvicorn's
 * "Application startup complete" message. The server is stopped when the
 * Electron app quits.
 */
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverProcess: ChildProcess | null = null;
let resolvedPort: number | null = null;
let startPromise: Promise<number> | null = null;

/**
 * Start the Python server if not already running.
 * Returns a promise that resolves with the port number when the server is ready.
 * On first run (model download) this may take several minutes.
 */
export function startPartnerServer(): Promise<number> {
  if (startPromise) return startPromise;

  const port = parseInt(process.env.PARTNER_SERVER_PORT ?? "8765", 10);
  startPromise = startPartnerServerProcess(port).catch((err) => {
    startPromise = null;
    throw err;
  });

  return startPromise;
}

async function startPartnerServerProcess(port: number): Promise<number> {
  if (await isPartnerServerHealthy(port)) {
    resolvedPort = port;
    console.log(`[python] Reusing existing Partner server on port ${port}`);
    return port;
  }

  return new Promise<number>((resolve, reject) => {
    // Resolve `python/` relative to this compiled file in `dist-electron/electron/`
    const pythonDir = path.resolve(__dirname, "../../python");

    console.log(
      `[python] Starting Partner server on port ${port} (cwd: ${pythonDir})`,
    );

    const proc = spawn("uv", ["run", "python", "server.py"], {
      cwd: pythonDir,
      env: {
        ...process.env,
        HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET ?? "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess = proc;
    let started = false;

    const markReady = () => {
      if (!started) {
        started = true;
        resolvedPort = port;
        console.log(`[python] Server ready on port ${port}`);
        resolve(port);
      }
    };

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) console.log(`[python server] ${line.trim()}`);
      }
      // uvicorn prints this on stdout or stderr depending on log config
      if (text.includes("Application startup complete")) {
        markReady();
      }
    };

    proc.stdout?.on("data", handleOutput);
    proc.stderr?.on("data", handleOutput);

    proc.on("error", (err) => {
      console.error("[python] Failed to spawn Partner server:", err.message);
      serverProcess = null;
      startPromise = null;
      if (!started) reject(err);
    });

    proc.on("close", (code) => {
      console.warn(`[python] Partner server exited (code ${code})`);
      serverProcess = null;
      resolvedPort = null;
      startPromise = null;
      if (!started) {
        reject(
          new Error(
            `Python server exited with code ${code} before becoming ready`,
          ),
        );
      }
    });

    // Do not resolve early while the model is still downloading/warming up.
    // The renderer should connect only after uvicorn reports startup complete.
  });
}

function isPartnerServerHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        timeout: 800,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve(
            response.statusCode === 200 &&
              body.includes('"status":"ok"') &&
              body.includes(
                '"model":"litert-community/gemma-4-E2B-it-litert-lm"',
              ),
          );
        });
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => {
      resolve(false);
    });
  });
}

/** Kill the Python server process (called on app quit). */
export function stopPartnerServer(): void {
  serverProcess?.kill();
  serverProcess = null;
  resolvedPort = null;
  startPromise = null;
}

/** Returns the port the server is listening on, or null if not yet started. */
export function getPartnerServerPort(): number | null {
  return resolvedPort;
}
