# Lab Reservation: Slack Bot + Tablet Dashboard

研究室・共同設備向けの予約システムです。TypeScript / Cloudflare Workers / D1で動作します。

## 機能

- Slackのボタン・モーダルで予約・変更・キャンセル・早期終了・延長
- 占有予約・数量予約・場所別の台数管理、故障点検
- タブレット向け一覧・設備別表示、日付別タイムライン、自動更新
- 秘密URL・QRによる入力不要の接続、氏名選択による共用端末からの予約
- 秘密URLのICS、任意のGoogleカレンダー連携
- 予約の競合検知、再送時の二重保存防止、D1上の操作記録

## 開発

Node.js 22以上を使用します。

```sh
npm ci
npm test
npm run typecheck
npm run dashboard:build
```

Cloudflareアカウントに自分のD1を作り、wrangler.tomlのdatabase_idとSlackの各IDを設定してください。本番設定・秘密鍵・既存データは含まれません。

```sh
npx wrangler login
npm run db:local
npm run db:remote
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DASHBOARD_SECRET
npm run deploy
```

Slack Appはslack-http-manifest.yamlを参考に作成し、URLを自分のWorkerの/slack/eventsへ変更します。Signing Secretによる署名検証が必要です。DBのresourcesに自分の設備設定を登録し、member_namesに利用者を登録します。config内はテスト用の架空フィクスチャで、本番に投入しないでください。予約初期データの投入は自動化していません。

タブレット画面は/dashboard/です。共通URLの発行はscripts/dashboard-shared-url.mjs、利用者の有効・無効はscripts/dashboard-member.mjsを使用します。.env.exampleの値は自分の環境で設定します。個人PINは廃止し、登録済みの氏名を選択して操作します。他人の名前でも操作できるため、研究室内でURLを共有する運用です。秘密URL・QRはアクセス権限そのものなので公開しないでください。

## 公開範囲

旧Python版、運用記録、実データSQL、画像、バックアップ、端末キー、PIN一覧は含めていません。固有名詞とIDは架空値に置換しています。実際の履歴取り込みに依存したテスト1件は除外しています。

公開リポジトリ: https://github.com/Kou-256/lab-reservation-slack-dashboard

## ライセンス

[MIT License](LICENSE)。著作権表示とライセンス文を保持すれば、商用利用・改変・再配布が可能です。無保証で提供します。依存パッケージには、それぞれのライセンスが適用されます。同梱するNoto Sans JPフォントはSIL Open Font License 1.1です。[第三者ライセンス](THIRD_PARTY_NOTICES.md)も参照してください。

## 全員が使う共通URL

スマートフォン・タブレット・PCで同じ秘密URLを使用できます。端末別の配布や利用台数の登録は不要です。`node --env-file=.env scripts/dashboard-shared-url.mjs`で共通URLを1つ発行し、`backups/dashboard-shared-link/研究室共通URL.html`から配布してください。再実行しても同じURLを使います。`--rotate`を付けると共通URLを再発行し、旧URLとその接続を無効化します。秘密を含む生成物はGit対象外です。同じ研究室内ネットワークから多数の端末が開いても、正常な接続を失敗回数として数えません。
