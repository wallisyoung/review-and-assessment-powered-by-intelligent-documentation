/**
 * Cognito Identity Provider関連のユーティリティ
 */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { ApplicationError } from "./errors";

// Cognitoクライアントのシングルトンインスタンス
let cognitoClient: CognitoIdentityProviderClient | null = null;

/**
 * Cognitoクライアントを取得する
 * @returns CognitoIdentityProviderClientインスタンス
 */
export function getCognitoClient(): CognitoIdentityProviderClient {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({
      region: process.env.AWS_REGION || "ap-northeast-1",
    });
  }
  return cognitoClient;
}

/**
 * 管理操作の対象となるUser Pool IDを取得する
 * @returns User Pool ID
 * @throws ApplicationError COGNITO_USER_POOL_IDが設定されていない場合
 */
export function getUserPoolId(): string {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new ApplicationError(
      "COGNITO_USER_POOL_ID is not configured for the API environment"
    );
  }
  return userPoolId;
}
