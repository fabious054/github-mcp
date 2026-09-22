import { MongoClient } from "mongodb";

// Conexão com o MongoDB segura pra ambiente serverless: a Vercel pode rodar
// muitas invocações concorrentes/sucessivas, e abrir uma conexão nova em
// cada uma delas estoura rápido o limite de conexões do Atlas (principalmente
// no tier free M0). O padrão recomendado é cachear o client (e a promise de
// connect() em andamento) numa variável global, pra uma invocação "quente"
// reaproveitar a mesma conexão em vez de abrir outra.

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI não configurado. Defina a connection string do MongoDB Atlas na Vercel."
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

// Origem pública do servidor, usada pra montar URLs absolutas (o link que
// 'link_account' devolve) a partir de dentro de uma chamada de ferramenta —
// onde, diferente das rotas OAuth (/authorize, /callback), não temos a mão o
// Request original pra derivar isso de headers. PUBLIC_ORIGIN é opcional e
// tem prioridade; na ausência, cai pras variáveis que a própria Vercel
// define automaticamente no deploy.
export function getServerOrigin(): string {
  const explicit = process.env.PUBLIC_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  throw new Error(
    "Não foi possível determinar a URL pública do servidor. Defina PUBLIC_ORIGIN na Vercel (ex: https://seu-projeto.vercel.app)."
  );
}
