export async function register() {
  const isolated = process.env.P0_02_ENABLED === 'true' || process.env.P0_01_ENABLED === 'true';
  if (!isolated) {
    return;
  }
  const label = process.env.P0_02_ENABLED === 'true' ? 'P0-02' : 'P0-01';
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL' || key.startsWith('PG')) {
      throw new Error(`${label} 隔离环境禁止加载 ${key}`);
    }
  }
}
