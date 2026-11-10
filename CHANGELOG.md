# Changelog

## [2.0.0](https://github.com/fx/ob/compare/v1.5.0...v2.0.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* **api:** the MCP tools list_files, list_folders, delete_file and delete_folder are removed, replaced by list and delete. The REST routes GET /v1/vaults/:slug/files, GET /v1/vaults/:slug/folders, DELETE /v1/vaults/:slug/files/*path and DELETE /v1/vaults/:slug/folders/*path are removed and now return the JSON 404, replaced by GET /v1/vaults/:slug/paths and DELETE /v1/vaults/:slug/paths/*path. No aliases are kept.

### Features

* **api:** add move and copy for files and folders ([#40](https://github.com/fx/ob/issues/40)) ([6748d23](https://github.com/fx/ob/commit/6748d23a01df36e177c1e77e0420372cb043b76e))
* **api:** replace per-type list and delete with unified path tools ([#38](https://github.com/fx/ob/issues/38)) ([958a9dc](https://github.com/fx/ob/commit/958a9dcabd6760dc36abc36120b3f460c6879cbf))
* **mcp:** add read-only grep tool and route ([#39](https://github.com/fx/ob/issues/39)) ([282e7cc](https://github.com/fx/ob/commit/282e7ccbd5339d9e603432b20cd0e89eae153252))
* **mcp:** add read-only list_tags tool and tags route ([#36](https://github.com/fx/ob/issues/36)) ([761f79a](https://github.com/fx/ob/commit/761f79a71d5577effdf741f05456d4db424422ae))

## [1.5.0](https://github.com/fx/ob/compare/v1.4.0...v1.5.0) (2026-11-04)


### Features

* **mcp:** mark the read-only tools readOnlyHint in tools/list ([#30](https://github.com/fx/ob/issues/30)) ([46a992e](https://github.com/fx/ob/commit/46a992e12fd66d13b298c73a13f01d6ade2af135))
* **sync:** retry sync forever by default and fail /healthz while sync stays down ([#28](https://github.com/fx/ob/issues/28)) ([4066035](https://github.com/fx/ob/commit/40660358cb39385aa1b4c60031157eb184b94753))


### Bug Fixes

* **deps:** upgrade hono to 4.13.16 ([#32](https://github.com/fx/ob/issues/32)) ([eecf227](https://github.com/fx/ob/commit/eecf227ab81cfcb542709be9ff1f65c5e6ac7f0e))
* **deps:** upgrade the MCP SDK to 1.32.2 and zod to 4.6.7 ([#33](https://github.com/fx/ob/issues/33)) ([3371d9a](https://github.com/fx/ob/commit/3371d9aee2eef0f188289f8ba2307e6d25f90657))

## [1.4.0](https://github.com/fx/ob/compare/v1.3.0...v1.4.0) (2026-09-15)


### Features

* **sync:** kill and restart a sync child that has stopped making progress ([#25](https://github.com/fx/ob/issues/25)) ([7d96b46](https://github.com/fx/ob/commit/7d96b46f161b858f428e3d20a05783cbc5201cab))
* **sync:** resolve and tail the upstream sync log, report it on /readyz ([#23](https://github.com/fx/ob/issues/23)) ([5834641](https://github.com/fx/ob/commit/58346415dbeaace1c56fdaed8eb47fccc6cf9a17))

## [1.3.0](https://github.com/fx/ob/compare/v1.2.0...v1.3.0) (2026-08-10)


### Features

* **mcp:** add scope resolution and scoped service deps ([#17](https://github.com/fx/ob/issues/17)) ([5b0a7f7](https://github.com/fx/ob/commit/5b0a7f7b4c4541d4e26df4d29064760cb408f93e))
* **mcp:** add scoped tool-surface helpers ([#16](https://github.com/fx/ob/issues/16)) ([20e86db](https://github.com/fx/ob/commit/20e86db9cd313c737ada634740a8b707d3b2f3f7))
* **mcp:** scope MCP sessions to a vault folder by URL ([#20](https://github.com/fx/ob/issues/20)) ([d4d8f36](https://github.com/fx/ob/commit/d4d8f36641a66a020f34c866aa63211e669f4d68))


### Bug Fixes

* **docker:** drop exact apt version pins that break on point releases ([#18](https://github.com/fx/ob/issues/18)) ([9b2dc9a](https://github.com/fx/ob/commit/9b2dc9a6b68a9bd07fce2585aa8d01a4f4d45dc6))

## [1.2.0](https://github.com/fx/ob/compare/v1.1.0...v1.2.0) (2026-07-02)


### Features

* **folders:** folder list/create/delete on REST and MCP ([#11](https://github.com/fx/ob/issues/11)) ([071d5ba](https://github.com/fx/ob/commit/071d5ba497a3c3a72c3de560b6ce1042d2198084))
* **read:** return extracted PDF text by default from read_file and REST JSON reads ([#8](https://github.com/fx/ob/issues/8)) ([b161236](https://github.com/fx/ob/commit/b161236cd1d863372539c04f08d16d3f9b39c977))


### Bug Fixes

* **indexer:** rank hybrid arms by relevance, not storage order ([#13](https://github.com/fx/ob/issues/13)) ([ae0a2c4](https://github.com/fx/ob/commit/ae0a2c46540da18054c906b31bcc99165dae49d6))

## [1.1.0](https://github.com/fx/ob/compare/v1.0.0...v1.1.0) (2026-05-06)


### Features

* env-driven ob sync-config bootstrap (change 0011) ([#4](https://github.com/fx/ob/issues/4)) ([09a9f21](https://github.com/fx/ob/commit/09a9f21059168f6cbc816c061c63b9ecaa1fdd2f))

## 1.0.0 (2026-05-04)


### Features

* initial public release ([d16fa74](https://github.com/fx/ob2/commit/d16fa744ddebf16a452b2e2fc4129cf43d4c04d3))

## Changelog
