// Loads .env before anything else reads process.env.
import { config } from "dotenv";
config({ quiet: true } as any);
