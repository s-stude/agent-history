import { databaseUrl, knexConfig } from './src/db.js';

export default knexConfig(databaseUrl());
