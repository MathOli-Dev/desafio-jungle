import { Inject, Injectable } from '@nestjs/common';
import { isRetryableConflict } from '@/application/errors';
import { Metrics } from '@/application/ports/observability';
import { Repositories, UnitOfWork } from '@/application/ports/repositories';
import { translateDbError } from './db-errors';
import { ORM } from './orm';
import type { Orm } from './orm';
import { buildRepositories } from './repositories/mikro-orm.repositories';

/**
 * Unidade de trabalho = UMA transação SQL (READ COMMITTED) sobre um EntityManager fork (Identity Map próprio).
 * Commit se `work` resolver; rollback se lançar. Erros do driver são traduzidos para a taxonomia da aplicação
 * e conflitos de concorrência alimentam a métrica de "lock conflicts".
 */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    @Inject(ORM) private readonly orm: Orm,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    super();
  }

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(buildRepositories(em)));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await work(buildRepositories(this.orm.em.fork()));
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    const translated = translateDbError(error);
    if (isRetryableConflict(translated)) this.metrics.lockConflict(translated.kind.toLowerCase());
    return translated;
  }
}
