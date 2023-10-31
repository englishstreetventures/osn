import { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema.ts',
  out: './src/db/drizzle',
  breakpoints: true,
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DB_URL
  }
} satisfies Config;
