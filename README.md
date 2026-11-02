# 175cm 軍人モデル（Blender / 手続き生成）

| ファイル | 内容 |
|---|---|
| `soldier_175cm.py` | モデル生成スクリプト（体・装備・ヘルメット・マスク・ライフル・リグ・シーン） |
| `soldier_motions.py` | モーション生成スクリプト（歩く／走る／しゃがみ歩き／匍匐 × 素手・小銃） |
| `soldier_175cm.blend` | ガスマスク版（マルチカム系装備）＋全モーション |
| `soldier_175cm_ghost.blend` | ゴーストマスク版（黒装備・スカル柄バラクラバ・4眼NVG・ヘッドセット）＋全モーション |
| `renders/` | 静止画プレビュー |
| `renders/motions/` | 各モーションのプレビュー動画 |

## モーション

Dope Sheet → **Action Editor** でアクションを切り替えます（ライフルも同じアクションで動きます）。
すべてループ可能で、アーマチュアオブジェクトの前進（ルートモーション）付き。30fps。

| アクション | 内容 | 周期 | 速度 |
|---|---|---|---|
| `Walk` | 通常歩行（ライフルは背中にスリング） | 32f | 1.2 m/s |
| `Walk_Rifle` | ローレディで歩行 | 32f | 1.1 m/s |
| `Run` | 走行（滞空期あり） | 20f | 3.6 m/s |
| `Run_Rifle` | 銃を斜めに抱えて走行 | 20f | 3.6 m/s |
| `Crouch` | しゃがみ歩き | 36f | 0.8 m/s |
| `Crouch_Rifle` | 照準しながらしゃがみ前進（頬付けを毎フレーム解く） | 36f | 0.7 m/s |
| `Prone` | 匍匐前進（ロークロール：肘で引き、膝を横に引き寄せて押す） | 48f | 0.34 m/s |
| `Prone_Rifle` | 銃を前腕の上に寝かせて匍匐 | 48f | 0.34 m/s |

その場で再生したい場合は、アクション内の `location`（Root Motion グループ）の F カーブをミュートしてください。

## 再生成

```bash
# ガスマスク版（モーション込み）
blender --background --python soldier_175cm.py -- --save soldier_175cm.blend --render renders
# ゴーストマスク版
blender --background --python soldier_175cm.py -- --variant ghost --save soldier_175cm_ghost.blend
# 既存の .blend にモーションだけ作り直す
blender soldier_175cm.blend --background --python soldier_motions.py -- --save soldier_175cm.blend
```

GUI では Scripting タブで `soldier_175cm.py` を開いて実行（末尾の `DEFAULT_VARIANT` で版を選択）。
