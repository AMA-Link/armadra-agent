/**
 * 宿主资源注册表（#270，host-api 1.2 `api.resources`）：`create()` 期间注册，宿主激活后冻结——
 * 系统提示工具节的资源行在会话开始时固定，之后 `register` 抛错。
 *
 * 校验：scheme `^[a-z][a-z0-9+.-]{1,31}$` 且不在保留字里（`http(s)` 归 web_fetch、`file` 归文件 read），
 * `describe` 单行 ≤ 120 字符，`read` 是函数，同名已存在抛 `tool_exists`，数量 ≤ 12。
 * 本注册表实现 `read` 工具查资源用的 {@link HostResourceLookup}；bootstrap 在第 12 步前创建它，
 * 既交给 read 工具也交给 HostApi。
 */

import { AmaError } from "../errors.js";
import { msg } from "../i18n/index.js";
import {
  MAX_HOST_RESOURCES,
  RESERVED_RESOURCE_SCHEMES,
  RESOURCE_SCHEME_RE,
  validResourceDescribe,
  type HostResource,
  type HostResourceLookup,
} from "../tools/resource-ref.js";

export class HostResourceRegistry implements HostResourceLookup {
  private readonly entries = new Map<string, HostResource>();
  private frozen = false;

  register(resource: HostResource): void {
    if (this.frozen) throw new AmaError("invalid_arguments", msg().drivers.host.resourceFrozen);
    if (typeof resource !== "object" || resource === null) {
      throw new AmaError("invalid_arguments", msg().drivers.host.resourceNotObject);
    }
    const scheme = resource.scheme;
    if (typeof scheme !== "string" || !RESOURCE_SCHEME_RE.test(scheme)) {
      throw new AmaError("invalid_arguments", msg().drivers.host.resourceBadScheme(String(scheme)));
    }
    if (RESERVED_RESOURCE_SCHEMES.has(scheme)) {
      throw new AmaError("invalid_arguments", msg().drivers.host.resourceReserved(scheme));
    }
    if (!validResourceDescribe(resource.describe)) {
      throw new AmaError("invalid_arguments", msg().drivers.host.resourceBadDescribe(scheme));
    }
    if (typeof resource.read !== "function") {
      throw new AmaError("invalid_arguments", msg().drivers.host.resourceNoRead(scheme));
    }
    if (this.entries.has(scheme)) {
      throw new AmaError("tool_exists", msg().drivers.host.resourceExists(scheme));
    }
    if (this.entries.size >= MAX_HOST_RESOURCES) {
      throw new AmaError(
        "invalid_arguments",
        msg().drivers.host.resourceTooMany(MAX_HOST_RESOURCES),
      );
    }
    this.entries.set(scheme, resource);
  }

  /** 宿主激活后调用：之后不再接受注册。 */
  freeze(): void {
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  get(scheme: string): HostResource | undefined {
    return this.entries.get(scheme);
  }

  schemes(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  /** 系统提示资源行的材料：按 scheme 排序的 `{ scheme, describe }`。 */
  list(): readonly { scheme: string; describe: string }[] {
    return this.schemes().map((scheme) => ({
      scheme,
      describe: (this.entries.get(scheme) as HostResource).describe,
    }));
  }
}
