/**
 * 登記書類整合性審査（抵当権設定）用 seed スクリプト
 *
 * デモで使う登記審査 CheckListSet を投入する:
 * - 4 種の 文書タイプ を宣言した CheckListSet (declaredDocumentTypes)
 * - 「総合審査」親項目（cascade で 総合判定 を担う）
 * - 17 件の 比較ルール を表す葉項目（各々 requiredDocumentTypes を持つ）
 *
 * 実行: cd backend && npm run db:seed:touki
 * ※ 事前にスキーマ反映（prisma migrate / generate）済みであること。
 * 冪等: upsert + delete & re-insert（毎デプロイで最新ルールに更新される）。CDK デプロイの Prisma マイグレーション Lambda から自動実行される。
 */

import { PrismaClient } from "../api/core/db";
import { ulid } from "ulid";

const prisma = new PrismaClient();

const DEFAULT_USER_ID = "user123";
const SET_NAME = "登記書類整合性審査（抵当権設定）";

// upsert 用の固定 set ID（増分デプロイで同一レコードを更新するため）
const TOUKI_SET_ID = "01HZ0UKISET000000000000000";

/** CheckListSet が期待する 文書タイプ（ビジネス上の書類種別。pdf/image はキャリアであり別物） */
const TOUKI_DOCUMENT_TYPES = [
  "抵当権設定契約証書",
  "登記完了証",
  "登記情報識別通知",
  "登記簿謄本",
] as const;

type DocType = (typeof TOUKI_DOCUMENT_TYPES)[number];

/**
 * 17 件の 比較ルール。
 * - description は agent への判定指示テキスト（比較元/比較先/正規化要点を含む）。
 * - requiredDocumentTypes は、このルールの判定で投入すべきスキャン書類の 文書タイプ。
 */
interface ComparisonRule {
  name: string;
  description: string;
  requiredDocumentTypes: DocType[];
}

const COMPARISON_RULES: ComparisonRule[] = [
  {
    name: "債務者氏名の一致",
    description:
      "「抵当権設定契約証書：表面」の「債務者氏名」と「案件情報」の「顧客氏名」が一致すること。正規化：氏名の全角・半角スペースは除去して比較。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "契約日と融資実行予定日の一致",
    description:
      "「抵当権設定契約証書：表面」の「抵当権設定」に記載の日付と「案件情報」の「借入情報：融資実行予定日」が一致すること。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "債権額と総借入希望額の一致",
    description:
      "「抵当権設定契約証書：表面」の「抵当権設定」に記載の金額（債権額）と「案件情報」の「借入情報：総借入希望額」が一致すること。正規化：カンマ区切りと非区切りは数値として同一とみなす。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "利率と適用金利の一致",
    description:
      "「抵当権設定契約証書：表面」の「抵当権設定」に記載の利率と「案件情報」の「借入情報：加減算後‗適用金利」が一致すること。正規化：全角「％」と半角「%」は同一とみなす。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "抵当権設定者氏名の存在",
    description:
      "「抵当権設定契約証書：表面」の各「抵当権設定者氏名」が「案件情報」の「連帯保証人」または「担保提供者」に存在すること。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "抵当権設定者氏名の個数の一致",
    description:
      "「抵当権設定契約証書：表面」の「抵当権設定者氏名」の個数と「案件情報」の「連帯保証人」と「担保提供者」の合計個数が一致すること。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "契約日と乙区の原因日付の一致",
    description:
      "「抵当権設定契約証書：表面」の「ご契約日」と「登記簿謄本：乙区」の「登記順位」が最大のレコードの「権力者その他の事項」の原因に記述された日付が一致すること。正規化：和暦と西暦が混在する場合は変換して比較。",
    requiredDocumentTypes: ["抵当権設定契約証書", "登記簿謄本"],
  },
  {
    name: "契約証書裏面住所と物件情報住所の同一性",
    description:
      "「抵当権設定契約証書：裏面」の「物件の表示」の住所情報と「案件情報」の「物件情報」の住所（登記簿住所/マンション名/号棟/部屋番号）が同じ住所であること。",
    requiredDocumentTypes: ["抵当権設定契約証書"],
  },
  {
    name: "識別通知の不動産住所と物件情報住所の同一性",
    description:
      "「登記情報識別通知」の「不動産」の住所情報と「案件情報」の「物件情報」の住所（登記簿住所/マンション名/号棟/部屋番号）が同じ住所であること。",
    requiredDocumentTypes: ["登記情報識別通知"],
  },
  {
    name: "識別通知の登記の目的",
    description:
      "「登記情報識別通知」の「登記の目的」が「抵当権設定」であること。",
    requiredDocumentTypes: ["登記情報識別通知"],
  },
  {
    name: "識別通知の目隠しシール文言",
    description:
      "「登記情報識別通知」の「目隠しシール」が「登録識別情報はこの中に記載しています。開封方法は裏面をご覧ください。」であること。",
    requiredDocumentTypes: ["登記情報識別通知"],
  },
  {
    name: "表題部住所と物件情報住所の同一性",
    description:
      "「登記簿謄本：表題部」の「所在」「番地」の住所情報と「案件情報」の「物件情報」の住所（登記簿住所/マンション名/号棟/部屋番号）が同じ住所であること。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
  {
    name: "表題部の地目",
    description: "「登記簿謄本：表題部」の「地目」が「宅地」であること。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
  {
    name: "表題部地積と土地面積の一致",
    description:
      "「登記簿謄本：表題部」の「地積」の値と「案件情報」の「物件情報：土地面積」の値が一致すること。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
  {
    name: "表題部床面積合計と延床面積の一致",
    description:
      "「登記簿謄本：表題部」の「床面積」の合計値と「案件情報」の「物件情報：延床面積」の値が一致すること。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
  {
    name: "表題部原因日付が融資実行予定日以降でないこと",
    description:
      "「登記簿謄本：表題部」の「原因及びその日付」中の日付は「案件情報」の「借入情報：融資実行予定日」以降ではないこと。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
  {
    name: "乙区の抵当権設定/抹消のペアリング",
    description:
      "「登記簿謄本：乙区」の「登記順位」が最大のレコード以外について、各「抵当権設定」のレコードに対して「抵当権抹消」のレコードが存在すること。",
    requiredDocumentTypes: ["登記簿謄本"],
  },
];

async function main(): Promise<void> {
  console.log("登記審査 seed を開始します...");

  const setId = TOUKI_SET_ID;

  // 既に存在する場合は完全スキップ（審査結果を保護）
  const existing = await prisma.checkListSet.findUnique({
    where: { id: setId },
  });
  if (existing) {
    console.log(
      `登記セット既存（id=${setId}）→ seed スキップ（審査結果保護）。ルール変更は duplicateChecklistSet で複製後に行うこと。`
    );
    return;
  }

  // 1. CheckListSet を作成
  await prisma.checkListSet.create({
    data: {
      id: setId,
      name: SET_NAME,
      description:
        "抵当権設定案件の書類間・書類と案件情報の整合性を審査するデモ用チェックリスト（17 件の比較ルール）。",
      userId: DEFAULT_USER_ID,
      declaredDocumentTypes: [...TOUKI_DOCUMENT_TYPES],
    },
  });
  console.log(`CheckListSet を作成しました: ${SET_NAME} (id=${setId})`);

  // 1b. ステータスを COMPLETED にするためのダミードキュメント
  await prisma.checkListDocument.create({
    data: {
      id: "01HZ0UKIDOC000000000000000",
      filename: "登記テンプレート（seed）",
      s3Path: "",
      fileType: "template",
      uploadDate: new Date(),
      checkListSetId: setId,
      userId: DEFAULT_USER_ID,
      status: "completed",
    },
  });
  console.log("ダミードキュメント（status=completed）を作成しました");

  // 2. 親項目「総合審査」+ 17 ルールを作成
  const parentId = ulid();
  await prisma.checkList.create({
    data: {
      id: parentId,
      name: "総合審査",
      description:
        "全比較ルールの集約。子項目の結果から cascade で 総合判定（承認可/条件付き保留/否認）を算出する。",
      checkListSetId: setId,
    },
  });

  for (const rule of COMPARISON_RULES) {
    await prisma.checkList.create({
      data: {
        id: ulid(),
        name: rule.name,
        description: rule.description,
        parentId,
        checkListSetId: setId,
        requiredDocumentTypes: rule.requiredDocumentTypes,
      },
    });
  }
  console.log(
    `親「総合審査」+ 葉項目 ${COMPARISON_RULES.length} 件を作成しました`
  );

  console.log("登記審査 seed が完了しました");
}

main()
  .catch((e) => {
    console.error("登記審査 seed 中にエラーが発生しました:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
