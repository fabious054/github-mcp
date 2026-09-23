import { MongoClient } from "mongodb";

// MongoDB connection, safe for a serverless environment: Vercel can run
// many concurrent/successive invocations, and opening a new connection on
// every single one quickly exhausts the Atlas connection limit (especially
// on the free M0 tier). The recommended pattern is to cache the client
// (and the in-flight connect() promise) in a global variable, so a "warm"
// invocation reuses the same connection instead of opening a new one.

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Define your MongoDB Atlas connection string on Vercel."
    );
  }
  return uri;
}

export function getMongoClientPromise(): Promise<MongoClient> {
  if (!global._mongoClientPromise) {
    const client = new MongoClient(getMongoUri());
    global._mongoClientPromise = client.connect();
  }
  return global._mongoClientPromise;
}

export async function getDb() {
  const client = await getMongoClientPromise();
  return client.db("github_mcp");
}

// The server's public origin, used to build absolute URLs (the link
// 'link_account' returns) from inside a tool call — where, unlike the OAuth
// routes (/authorize, /callback), we don't have the original Request handy
// to derive this from headers. PUBLIC_ORIGIN is optional and takes
// priority; absent that, it falls back to the variables Vercel itself sets
// automatically on deploy.
export function getServerOrigin(): string {
  const explicit = process.env.PUBLIC_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  throw new Error(
    "Could not determine the server's public URL. Set PUBLIC_ORIGIN on Vercel (e.g. https://your-project.vercel.app)."
  );
}
