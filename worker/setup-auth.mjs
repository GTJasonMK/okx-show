#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const ITERATIONS = 210000;
const HASH_LENGTH = 32;
const workerDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("setup-auth.mjs must run in an interactive terminal.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const username = (await rl.question("Dashboard username: ")).trim();
  rl.close();

  if (!username) {
    throw new Error("Username is required.");
  }

  const password = await promptHidden("Dashboard password: ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }

  const salt = randomBytes(16);
  const passwordHash = pbkdf2Sync(password, salt, ITERATIONS, HASH_LENGTH, "sha256");
  const sessionSecret = base64Url(randomBytes(32));

  putSecret("DASHBOARD_AUTH_USERNAME", username);
  putSecret("DASHBOARD_AUTH_SALT", salt.toString("hex"));
  putSecret("DASHBOARD_AUTH_PASSWORD_HASH", passwordHash.toString("hex"));
  putSecret("DASHBOARD_AUTH_ITERATIONS", String(ITERATIONS));
  putSecret("DASHBOARD_SESSION_SECRET", sessionSecret);

  console.log("Dashboard auth secrets have been written to Cloudflare Worker.");
}

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
    }

    function onData(buffer) {
      for (const byte of buffer) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Interrupted."));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) {
          value += String.fromCharCode(byte);
        }
      }
    }

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function putSecret(name, value) {
  console.log(`Writing ${name}...`);
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: workerDir,
    encoding: "utf8",
    input: `${value}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to write ${name}.`);
  }
}

function base64Url(bytes) {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
