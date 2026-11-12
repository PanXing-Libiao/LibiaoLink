import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../db/database.service.js";

export interface FileArchiveLock {
  release(): Promise<void>;
}

/** 同账号同时只允许一个服务端打包任务；用 PG 会话级 advisory lock 覆盖多 API 实例。 */
@Injectable()
export class FileArchiveConcurrency {
  constructor(private readonly database: DatabaseService) {}

  async acquire(actorId: string): Promise<FileArchiveLock | null> {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked",
        ["file-archive:" + actorId],
      );
      if (result.rows[0]?.locked !== true) {
        client.release();
        return null;
      }
      return {
        release: async (): Promise<void> => {
          try {
            await client.query("select pg_advisory_unlock(hashtext($1))", ["file-archive:" + actorId]);
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }
}
