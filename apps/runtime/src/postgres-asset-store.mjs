function assetRow(row) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    id: String(row.id),
    spaceId: String(row.space_id),
    ownerId: String(row.owner_id),
    state: String(row.state),
    mediaKind: String(row.media_kind),
    mediaType: String(row.media_type),
    byteLength: Number(row.byte_length),
    sha256: String(row.sha256),
    blobKey: String(row.blob_key),
    ...(row.original_name ? { originalName: String(row.original_name) } : {}),
    createdAt: Number(row.created_at)
  };
}

export class PostgresAssetStore {
  constructor(pool, { spaceId }) {
    if (!pool?.query) throw new Error("PostgreSQL Asset store requires a Pool");
    this.pool = pool;
    this.spaceId = String(spaceId || "");
    if (!this.spaceId) throw new Error("PostgreSQL Asset store requires a Space");
  }

  async create(asset) {
    const result = await this.pool.query(
      `INSERT INTO runtime_assets
       (space_id, id, owner_id, state, media_kind, media_type, byte_length,
        sha256, blob_key, original_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        this.spaceId,
        String(asset.id),
        String(asset.ownerId),
        String(asset.state),
        String(asset.mediaKind),
        String(asset.mediaType),
        Number(asset.byteLength),
        String(asset.sha256),
        String(asset.blobKey),
        asset.originalName ? String(asset.originalName) : null,
        Number(asset.createdAt)
      ]
    );
    return assetRow(result.rows[0]);
  }

  async get(assetId) {
    const result = await this.pool.query(
      `SELECT * FROM runtime_assets
       WHERE space_id = $1 AND id = $2`,
      [this.spaceId, String(assetId)]
    );
    return assetRow(result.rows[0]);
  }

  async withBlobLock(sha256, action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`asset-blob:${this.spaceId}:${sha256}`]);
      const result = await action(new PostgresAssetStore(client, { spaceId: this.spaceId }));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async isBlobReferenced(key) {
    return (await this.pool.query("SELECT 1 FROM runtime_assets WHERE space_id=$1 AND blob_key=$2 LIMIT 1",
      [this.spaceId, key])).rowCount > 0;
  }
}
