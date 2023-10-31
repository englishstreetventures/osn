import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

export * as schema from "./schema";

export const client = new Client({ connectionString: Bun.env.DB_URL });

client.connect();
export const db = drizzle(client);

// TODO: start using when bun supports 'using' keyword
// export const getDB = async () => {
//   await client.connect();
//   const connection = drizzle(client);

//   return {
//     connection,
//     [Symbol.asyncDispose]: async () => {
//       await client.end();
//     }
//   }
// }
