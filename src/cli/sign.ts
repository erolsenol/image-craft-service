import { signTransformUrl } from "../security/signing.js";

const [input, ...arguments_] = process.argv.slice(2);
const secret = process.env.SIGNING_SECRET;

try {
  if (!input || !secret) {
    throw new Error(
      "Usage: SIGNING_SECRET=<secret> npm run sign -- <url> [--expires-in <seconds>]",
    );
  }

  let expires: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--expires-in")
      throw new Error("Only --expires-in <seconds> is supported");
    const duration = Number(arguments_[index + 1]);
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw new Error("--expires-in must be a positive integer");
    expires = String(Math.floor(Date.now() / 1000) + duration);
    index += 1;
  }

  console.log(signTransformUrl(input, secret, expires));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to sign URL");
  process.exitCode = 1;
}
