import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createLocalDb(filename = ':memory:') {
    const db = new DatabaseSync(filename);
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    return {
        prepare(sql) {
            const statement = db.prepare(sql);
            const bound = values => ({
                first: async () => statement.get(...values) || null,
                all: async () => ({ results: statement.all(...values) }),
                run: () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
            });
            return { bind: (...values) => bound(values), ...bound([]) };
        },
        batch(statements) {
            db.exec('BEGIN');
            try {
                const output = statements.map(statement => statement.run());
                db.exec('COMMIT');
                return output;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        close: () => db.close(),
    };
}
