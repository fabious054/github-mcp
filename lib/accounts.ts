import { encryptJson, decryptJson } from "./oauth";
import { getDb } from "./mongo";

// Contas GitHub adicionais vinculadas a uma conta primária (ADR 0002:
// vínculo ancorado na identidade real do GitHub, nunca em algo gerado pelo
// cliente MCP). O token de cada conta vinculada é guardado criptografado
// (reaproveita o AES-256-GCM já usado no fluxo de OAuth, em lib/oauth.ts) —
// nunca em texto puro no banco.

export type LinkedAccount = {
  login: string;
  token: string; // já decriptado quando devolvido por getLinkedAccounts
  linkedAt: string;
};

type LinkedAccountDoc = {
  primaryLogin: string;
  login: string;
  encryptedToken: string;
  linkedAt: string;
};

const COLLECTION = "linked_accounts";

export async function linkAccount(primaryLogin: string, login: string, token: string): Promise<void> {
  const db = await getDb();
  const encryptedToken = encryptJson({ token });
  await db.collection<LinkedAccountDoc>(COLLECTION).updateOne(
    { primaryLogin, login },
    { $set: { primaryLogin, login, encryptedToken, linkedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

export async function getLinkedAccounts(primaryLogin: string): Promise<LinkedAccount[]> {
  const db = await getDb();
  const docs = await db.collection<LinkedAccountDoc>(COLLECTION).find({ primaryLogin }).toArray();
  return docs.map((d) => {
    const { token } = decryptJson<{ token: string }>(d.encryptedToken);
    return { login: d.login, token, linkedAt: d.linkedAt };
  });
}
