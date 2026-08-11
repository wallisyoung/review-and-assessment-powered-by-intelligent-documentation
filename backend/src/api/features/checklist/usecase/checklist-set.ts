import { CreateChecklistSetRequest } from "../routes/handlers";
import {
  CheckRepository,
  makePrismaCheckRepository,
} from "../domain/repository";
import {
  CheckListSetDomain,
  CheckListSetEntity,
  CheckListItemEntity,
  CheckListItemDetail,
  CheckListSetSummary,
  CheckListSetDetailModel,
  CHECK_LIST_STATUS,
  AmbiguityFilter,
} from "../domain/model/checklist";
import { PaginatedResponse } from "../../../common/types";
import { ulid } from "ulid";
import { z } from "zod";
import { makePrismaToolConfigurationRepository } from "../../tool-configuration/domain/repository";
import { getAvailableModels as getAvailableModelsFromEnv } from "../domain/model/available-models";
import { getPresignedUrl, getS3ObjectSize } from "../../../core/s3";
import { getChecklistOriginalKey } from "../../../../checklist-workflow/common/storage-paths";
import {
  ApplicationError,
  FileSizeExceededError,
} from "../../../core/errors/application-errors";
import { ValidationError } from "../../../core/errors";
import { startStateMachineExecution } from "../../../core/sfn";
import { sendMessage } from "../../../core/sqs";
import { validateFileSize } from "../../../core/file-validation";
import { MAX_FILE_SIZE } from "../../../constants/index";
import {
  assertHasOwnerAccessOrThrow,
  RequestUser,
} from "../../../core/middleware/authorization";

const assertChecklistSetOwner = async (params: {
  user: RequestUser;
  checkListSetId: string;
  repo: CheckRepository;
  api: string;
  resourceId?: string;
  operation: "read" | "write";
}): Promise<void> => {
  const checkListSet = await params.repo.findCheckListSetDetailById(
    params.checkListSetId
  );

  // 共有チェックリスト（declaredDocumentTypes 非 null）のアクセス制御
  const isShared = (checkListSet.declaredDocumentTypes ?? []).length > 0;
  if (isShared) {
    if (params.operation === "read") return;
    if (params.operation === "write" && params.user.isAdmin) return;
    throw new ApplicationError("共有チェックリストは管理者のみ変更可能です");
  }

  // 非共有 → 従来通り所有者チェック
  const ownerUserId = checkListSet.userId;
  assertHasOwnerAccessOrThrow(params.user, ownerUserId, {
    api: params.api,
    resourceId: params.resourceId ?? params.checkListSetId,
    logger: console,
  });
};

export const createChecklistSet = async (params: {
  req: CreateChecklistSetRequest;
  userId: string;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<void> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());

  const { req } = params;
  const checkListSet = CheckListSetDomain.fromCreateRequest(req);
  await repo.storeCheckListSet({
    checkListSet,
    ownerUserId: params.userId,
  });

  const stateMachineArn = process.env.DOCUMENT_PROCESSING_STATE_MACHINE_ARN;
  if (!stateMachineArn) {
    throw new ApplicationError(
      "DOCUMENT_PROCESSING_STATE_MACHINE_ARN is not defined"
    );
  }

  // NOTE: Currently, only the first document is processed.
  if (req.documents.length === 0) {
    throw new ApplicationError("No documents found in the request");
  } else if (req.documents.length > 1) {
    throw new ApplicationError("Multiple documents are not supported");
  }
  const doc = req.documents[0];

  // Validate file size from S3
  const bucketName = process.env.DOCUMENT_BUCKET;
  if (!bucketName) {
    throw new ApplicationError("DOCUMENT_BUCKET is not defined");
  }

  try {
    const fileSize = await getS3ObjectSize(bucketName, doc.s3Key);
    if (!validateFileSize(fileSize, MAX_FILE_SIZE)) {
      throw new FileSizeExceededError(doc.filename, fileSize, MAX_FILE_SIZE);
    }
  } catch (error) {
    if (error instanceof FileSizeExceededError) {
      throw error;
    }
    // If file doesn't exist or other S3 error, let it proceed (will fail later in processing)
    console.warn(`Could not validate file size for ${doc.s3Key}:`, error);
  }

  await startStateMachineExecution(stateMachineArn, {
    documentId: doc.documentId,
    fileName: doc.filename,
    checkListSetId: checkListSet.id,
    userId: params.userId,
  });
};

export const updateChecklistSet = async (params: {
  req: {
    Params: { setId: string };
    Body: {
      name?: string;
      description?: string;
      declaredDocumentTypes?: string[];
    };
  };
  user: RequestUser;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<void> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());
  const { setId } = params.req.Params;
  const { name, description, declaredDocumentTypes } = params.req.Body;

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId: setId,
    repo,
    api: "updateChecklistSet",
    operation: "write",
  });

  // 使用済み（レビュージョブ存在）のセットは編集不可
  const isEditable = await repo.checkSetEditable({ setId });
  if (!isEditable) {
    throw new ValidationError(
      "使用済み（レビュージョブが存在する）チェックリストセットは編集できません"
    );
  }

  // declaredDocumentTypes からタイプを削除する場合、そのタイプを requiredDocumentTypes で
  // 参照しているルールがないか検証（あれば削除を拒否）。
  if (declaredDocumentTypes !== undefined) {
    const current = await repo.findCheckListSetDetailById(setId);
    const currentTypes = current.declaredDocumentTypes ?? [];
    const removed = currentTypes.filter(
      (t) => !declaredDocumentTypes.includes(t)
    );
    if (removed.length > 0) {
      const items = await repo.findCheckListItems(setId, undefined, true);
      const blockers = items
        .filter(
          (it) =>
            it.requiredDocumentTypes &&
            it.requiredDocumentTypes.some((t) => removed.includes(t))
        )
        .map((it) => ({
          name: it.name,
          types: (it.requiredDocumentTypes ?? []).filter((t) =>
            removed.includes(t)
          ),
        }));
      if (blockers.length > 0) {
        const detail = blockers
          .map((b) => `「${b.name}」(参照: ${b.types.join(", ")})`)
          .join("; ");
        throw new ValidationError(
          `削除対象の文書タイプはルールで使用中のため削除できません。先に該当ルールの requiredDocumentTypes から解除してください: ${detail}`
        );
      }
    }
  }

  await repo.updateCheckListSet({
    setId,
    name,
    description,
    declaredDocumentTypes,
  });
};

/**
 * チェックリスト項目を階層順（親→子）で一括保存する。
 * 親IDのFK制約上、親が先に存在する必要があるためレベルごとに挿入する。
 * duplicate / import で共有。
 */
const persistItemsInHierarchy = async (
  repo: CheckRepository,
  items: CheckListItemEntity[]
): Promise<void> => {
  if (items.length === 0) return;

  const itemsByLevel = new Map<number, CheckListItemEntity[]>();
  const rootItems = items.filter((item) => !item.parentId);
  itemsByLevel.set(0, rootItems);

  const processedIds = new Set(rootItems.map((item) => item.id));
  let remainingItems = items.filter((item) => item.parentId);
  let currentLevel = 0;

  while (remainingItems.length > 0) {
    currentLevel++;
    const currentLevelItems = remainingItems.filter(
      (item) => item.parentId && processedIds.has(item.parentId)
    );
    if (currentLevelItems.length === 0) {
      console.error(
        `[Warning] Possible circular reference detected in checklist items. Unable to process ${remainingItems.length} items with parent references.`
      );
      break;
    }
    itemsByLevel.set(currentLevel, currentLevelItems);
    currentLevelItems.forEach((item) => processedIds.add(item.id));
    remainingItems = remainingItems.filter(
      (item) => !currentLevelItems.includes(item)
    );
  }

  for (let level = 0; level <= currentLevel; level++) {
    const levelItems = itemsByLevel.get(level) || [];
    if (levelItems.length > 0) {
      await repo.bulkStoreCheckListItems({ items: levelItems });
    }
  }
};

export const duplicateChecklistSet = async (params: {
  sourceCheckListSetId: string;
  newName?: string;
  newDescription?: string;
  userId: string;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<void> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());
  const { sourceCheckListSetId, newName, newDescription } = params;

  // 1. 元のチェックリストセットを取得
  const sourceCheckListSet =
    await repo.findCheckListSetDetailById(sourceCheckListSetId);

  // 2. 新しいチェックリストセットを作成
  const newCheckListSet = CheckListSetDomain.fromDuplicateRequest(
    sourceCheckListSetId,
    newName,
    newDescription,
    sourceCheckListSet
  );

  // 3. 新しいチェックリストセットを保存
  await repo.storeCheckListSet({
    checkListSet: newCheckListSet,
    ownerUserId: params.userId,
  });

  // 4. 元のチェックリストの項目を全て取得
  const sourceItems = await repo.findCheckListItems(
    sourceCheckListSetId,
    undefined,
    true // すべての子項目を含める
  );

  if (sourceItems.length === 0) {
    return; // 項目がなければ終了
  }

  // 5. IDマッピングを作成（古いID -> 新しいID）
  const idMapping = new Map<string, string>();
  sourceItems.forEach((item) => {
    idMapping.set(item.id, ulid());
  });

  // 6. 新しいチェックリスト項目を作成
  const newItems = sourceItems.map((item) => ({
    id: idMapping.get(item.id)!,
    setId: newCheckListSet.id,
    name: item.name,
    description: item.description || "",
    parentId: item.parentId ? idMapping.get(item.parentId) : undefined,
    requiredDocumentTypes: item.requiredDocumentTypes,
    modelId: item.modelId,
    toolConfigurationId: item.toolConfigurationId,
  }));

  // 7. 新しいチェックリスト項目を階層順に保存（親→子）
  await persistItemsInHierarchy(repo, newItems);
};

// =========================================================================
// Export / Import（reviewset 設定の持ち出し・取り込み）
// =========================================================================

export type ExportedChecklistSet = {
  format: string;
  version: number;
  set: {
    name: string;
    description: string;
    declaredDocumentTypes?: string[];
  };
  items: Array<{
    id: string;
    parentId: string | null;
    name: string;
    description: string;
    requiredDocumentTypes?: string[];
    modelId?: string;
    toolConfigurationId?: string;
  }>;
};

/**
 * チェックリストセットの設定（set メタデータ + items ツリー + 逐項設定）を
 * エクスポート用 JSON として直列化する。ドキュメント/審査結果は含まない。
 */
export const exportChecklistSet = async (params: {
  setId: string;
  user: RequestUser;
  deps?: { repo?: CheckRepository };
}): Promise<ExportedChecklistSet> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());
  const { setId } = params;

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId: setId,
    repo,
    api: "exportChecklistSet",
    operation: "read",
  });

  const setDetail = await repo.findCheckListSetDetailById(setId);
  const items = await repo.findCheckListItems(setId, undefined, true);

  return {
    format: "rapid-checklist-set",
    version: 1,
    set: {
      name: setDetail.name,
      description: setDetail.description || "",
      declaredDocumentTypes: setDetail.declaredDocumentTypes,
    },
    items: items.map((it) => ({
      id: it.id,
      parentId: it.parentId ?? null,
      name: it.name,
      description: it.description || "",
      requiredDocumentTypes: it.requiredDocumentTypes,
      modelId: it.modelId,
      toolConfigurationId: it.toolConfigurationId,
    })),
  };
};

const ImportChecklistSetSchema = z.object({
  format: z.string(),
  version: z.number(),
  set: z.object({
    name: z.string().min(1),
    description: z.string().optional().default(""),
    declaredDocumentTypes: z.array(z.string()).optional(),
  }),
  items: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable().optional(),
      name: z.string().min(1),
      description: z.string().optional().default(""),
      requiredDocumentTypes: z.array(z.string()).optional(),
      modelId: z.string().optional(),
      toolConfigurationId: z.string().optional(),
    })
  ),
});

/**
 * エクスポート済み JSON から新しいチェックリストセットを取り込む。
 * - ドキュメント処理は行わない（テンプレートとして新規作成）。
 * - modelId / toolConfigurationId は現環境に存在する場合のみ引き継ぐ（無ければ除去）。
 * - items は新しい id で再構築し、parentId を旧id→新id でリマップして階層を復元。
 */
export const importChecklistSet = async (params: {
  data: unknown;
  user: RequestUser;
  deps?: { repo?: CheckRepository };
}): Promise<{ setId: string }> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());

  let parsed;
  try {
    parsed = ImportChecklistSetSchema.parse(params.data);
  } catch (e) {
    throw new ValidationError(
      `Invalid checklist set import file: ${(e as Error).message}`
    );
  }
  const { set: setInput, items: inputItems } = parsed;

  // 参照先の妥当性チェック用: 現環境の有効なモデル ID と ツール設定 ID
  const validModelIds = new Set(
    getAvailableModelsFromEnv().map((m) => m.modelId)
  );
  const toolRepo = await makePrismaToolConfigurationRepository();
  const validToolConfigIds = new Set(
    (await toolRepo.findAll()).map((c) => c.id)
  );

  // 新しい set を作成（ドキュメント処理なしのテンプレート）
  const newSetId = ulid();
  const newSet: CheckListSetEntity = {
    id: newSetId,
    name: setInput.name,
    description: setInput.description,
    documents: [],
    declaredDocumentTypes: setInput.declaredDocumentTypes,
    createdAt: new Date(),
  };
  await repo.storeCheckListSet({
    checkListSet: newSet,
    ownerUserId: params.user.userId,
  });

  // items を新しい id で再構築。parentId は旧id→新id でリマップ。
  const idMapping = new Map<string, string>();
  inputItems.forEach((it) => idMapping.set(it.id, ulid()));

  const newItems: CheckListItemEntity[] = inputItems.map((it) => ({
    id: idMapping.get(it.id)!,
    setId: newSetId,
    name: it.name,
    description: it.description || "",
    parentId: it.parentId ? idMapping.get(it.parentId) : undefined,
    requiredDocumentTypes: it.requiredDocumentTypes,
    // 参照先が現環境に無ければ除外（FK 違反・無効参照を防ぐ）
    modelId:
      it.modelId && validModelIds.has(it.modelId) ? it.modelId : undefined,
    toolConfigurationId:
      it.toolConfigurationId && validToolConfigIds.has(it.toolConfigurationId)
        ? it.toolConfigurationId
        : undefined,
  }));

  await persistItemsInHierarchy(repo, newItems);

  return { setId: newSetId };
};

export const removeChecklistSet = async (params: {
  checkListSetId: string;
  user: RequestUser;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<void> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());

  const { checkListSetId } = params;

  const checkListSet = await repo.findCheckListSetDetailById(checkListSetId);

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId,
    repo,
    api: "removeChecklistSet",
    operation: "write",
  });

  await repo.deleteCheckListSetById({
    checkListSetId,
  });
};

export const getAllChecklistSets = async (params: {
  status?: CHECK_LIST_STATUS;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  ownerUserId?: string;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<PaginatedResponse<CheckListSetSummary>> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());

  const result = await repo.findAllCheckListSets({
    status: params.status,
    page: params.page,
    limit: params.limit,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
    ownerUserId: params.ownerUserId,
  });
  return result;
};

export const getCheckListDocumentPresignedUrl = async (params: {
  filename: string;
  contentType: string;
}): Promise<{ url: string; key: string; documentId: string }> => {
  const { filename, contentType } = params;
  const bucketName = process.env.DOCUMENT_BUCKET;
  if (!bucketName) {
    throw new Error("S3_BUCKET_NAME is not defined");
  }
  const documentId = ulid();
  const key = getChecklistOriginalKey(documentId, filename);
  const url = await getPresignedUrl(bucketName, key, contentType);

  return { url, key, documentId };
};

export const getChecklistItems = async (params: {
  checkListSetId: string;
  parentId?: string;
  includeAllChildren?: boolean;
  ambiguityFilter?: AmbiguityFilter;
  user: RequestUser;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<CheckListItemDetail[]> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId: params.checkListSetId,
    repo,
    api: "getChecklistItems",
    operation: "read",
  });

  const { checkListSetId, parentId, includeAllChildren, ambiguityFilter } =
    params;
  const checkListItems = await repo.findCheckListItems(
    checkListSetId,
    parentId,
    includeAllChildren,
    ambiguityFilter
  );
  return checkListItems;
};

export const getChecklistSetById = async (params: {
  checkListSetId: string;
  user: RequestUser;
  deps?: {
    repo?: CheckRepository;
  };
}): Promise<CheckListSetDetailModel> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());
  const { checkListSetId } = params;
  const checkListSet = await repo.findCheckListSetDetailById(checkListSetId);

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId,
    repo,
    api: "getChecklistSetById",
    operation: "read",
  });

  return checkListSet;
};

export const startAmbiguityDetection = async (params: {
  checkListSetId: string;
  userId: string;
  user: RequestUser;
  deps?: {
    repo?: CheckRepository;
    sqsQueueUrl?: string;
  };
}): Promise<void> => {
  const repo = params.deps?.repo || (await makePrismaCheckRepository());
  const queueUrl =
    params.deps?.sqsQueueUrl || process.env.AMBIGUITY_DETECTION_QUEUE_URL!;

  await assertChecklistSetOwner({
    user: params.user,
    checkListSetId: params.checkListSetId,
    repo,
    api: "startAmbiguityDetection",
    operation: "write",
  });

  // Update document status to detecting
  const checkListSet = await repo.findCheckListSetDetailById(
    params.checkListSetId
  );
  if (checkListSet.documents.length > 0) {
    await repo.updateDocumentStatus({
      documentId: checkListSet.documents[0].id,
      status: CHECK_LIST_STATUS.DETECTING,
    });
  }

  // Send message to SQS
  await sendMessage(queueUrl, {
    checkListSetId: params.checkListSetId,
    userId: params.userId,
  });
};
