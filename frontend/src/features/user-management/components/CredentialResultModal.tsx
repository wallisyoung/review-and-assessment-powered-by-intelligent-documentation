import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { HiClipboard, HiClipboardCheck, HiExclamation } from "react-icons/hi";
import Modal from "../../../components/Modal";
import Button from "../../../components/Button";
import type { CreatedUserResult } from "../types";

interface CredentialResultModalProps {
  result: CreatedUserResult | null;
  onClose: () => void;
}

/**
 * 発行した一時パスワードを一度だけ表示するモーダル。
 * 閉じた後に再表示はできないため、管理者がコピーして別手段で伝達する
 */
export default function CredentialResultModal({
  result,
  onClose,
}: CredentialResultModalProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードAPIが利用できない場合は手動コピーしてもらう
    }
  };

  if (!result) return null;

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t("userManagement.credentialTitle")}
      size="md">
      <div className="space-y-4">
        <div className="flex items-start rounded-md border border-yellow-400 bg-yellow-50 px-4 py-3 text-sm text-yellow-700">
          <HiExclamation className="mr-2 mt-0.5 h-5 w-5 shrink-0" />
          <span>{t("userManagement.credentialWarning")}</span>
        </div>

        <dl className="space-y-3">
          <div>
            <dt className="text-sm font-medium text-aws-font-color-gray">
              {t("userManagement.email")}
            </dt>
            <dd className="mt-1 break-all text-sm text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
              {result.user.email || result.user.username}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-aws-font-color-gray">
              {t("userManagement.temporaryPassword")}
            </dt>
            <dd className="mt-1 flex items-center space-x-2">
              <code className="break-all rounded-md border border-light-gray bg-aws-paper-light px-3 py-2 font-mono text-sm text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
                {result.temporaryPassword}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopy}
                icon={
                  copied ? (
                    <HiClipboardCheck className="h-5 w-5" />
                  ) : (
                    <HiClipboard className="h-5 w-5" />
                  )
                }>
                {copied
                  ? t("userManagement.copied")
                  : t("userManagement.copy")}
              </Button>
            </dd>
          </div>
        </dl>

        <p className="text-sm text-aws-font-color-gray">
          {t("userManagement.firstLoginNote")}
        </p>

        <div className="flex justify-end border-t border-light-gray pt-4">
          <Button variant="primary" onClick={onClose}>
            {t("userManagement.credentialDone")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
