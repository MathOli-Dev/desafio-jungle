import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
/** Marca rotas que nunca exigem autenticação (health, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * PONTO DE EXTENSÃO de autenticação (ver ARCHITECTURE.md §Autenticação). Hoje é no-op por decisão documentada.
 * Com Keycloak/Zitadel: validar o JWT (OIDC, JWKS), anexar o Principal a `request.principal` e, no controller,
 * chamar `ProviderIdentityPort.assertCanActFor(principal, providerId)`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return true; // no-op: sem IdP configurado
  }
}
