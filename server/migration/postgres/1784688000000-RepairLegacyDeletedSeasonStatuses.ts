import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairLegacyDeletedSeasonStatuses1784688000000 implements MigrationInterface {
  name = 'RepairLegacyDeletedSeasonStatuses1784688000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Season rows cannot be blocklisted independently. Older Seerr builds wrote
    // DELETED as 6, which is now the value of BLOCKLISTED after DELETED moved to 7.
    await queryRunner.query(
      `UPDATE "season" SET "status" = 7 WHERE "status" = 6`
    );
    await queryRunner.query(
      `UPDATE "season" SET "status4k" = 7 WHERE "status4k" = 6`
    );
  }

  public async down(): Promise<void> {
    // This is a one-way data repair. Converting every DELETED season back to 6
    // would make valid rows appear BLOCKLISTED on current builds.
  }
}
