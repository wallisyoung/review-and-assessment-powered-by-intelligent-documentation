-- 登記 文書タイプ の整理（一回限り・冪等）
-- 「登記簿謄本」→「建物登記簿謄本」にリネームし、新タイプ 3 種（本地/道路/隣地登記簿謄本）を追加。
-- 旧値「登記簿謄本」を含まない環境（新規 seed 済みや二度目の実行）では該当行がなく no-op。

-- 1) CheckListSet.declaredDocumentTypes:
--    旧「登記簿謄本」を含む登記セット（抵当権設定契約証書 を含むもの）を新 7 種で上書き。
UPDATE check_list_sets
SET declared_document_types = JSON_ARRAY(
      '抵当権設定契約証書',
      '登記完了証',
      '登記情報識別通知',
      '建物登記簿謄本',
      '本地登記簿謄本',
      '道路登記簿謄本',
      '隣地登記簿謄本'
    )
WHERE JSON_CONTAINS(declared_document_types, JSON_QUOTE('抵当権設定契約証書'))
  AND JSON_CONTAINS(declared_document_types, JSON_QUOTE('登記簿謄本'));

-- 2) CheckList.requiredDocumentTypes:
--    配列要素 "登記簿謄本" を "建物登記簿謄本" にリネーム（該当 7 ルール: 07, 12-17 を一括）。
UPDATE check_lists
SET required_document_types = CAST(
      REPLACE(
        CAST(required_document_types AS CHAR(1000) CHARACTER SET utf8mb4),
        '"登記簿謄本"',
        '"建物登記簿謄本"'
      ) AS JSON
    )
WHERE JSON_CONTAINS(required_document_types, JSON_QUOTE('登記簿謄本'));

-- 3) ReviewDocument.documentType:
--    VARCHAR 列の "登記簿謄本" を "建物登記簿謄本" にリネーム（既存の審査ドキュメントも追従）。
UPDATE review_documents
SET document_type = '建物登記簿謄本'
WHERE document_type = '登記簿謄本';
