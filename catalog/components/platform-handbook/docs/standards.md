# Padrões de serviço

Todo `Component` do tipo `service` deve ter:

1. `metadata.description` preenchido.
2. `spec.owner` apontando para um **Group** (não para um usuário).
3. `spec.system` definido.
4. `spec.lifecycle` diferente de `deprecated` para serviços em uso.
5. TechDocs configurado (`backstage.io/techdocs-ref`).
6. APIs expostas declaradas em `providesApis`.
