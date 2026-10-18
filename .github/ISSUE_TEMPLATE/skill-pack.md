name: 技能包投稿
about: 为技能商店贡献一个技能包（不会用 Git 也可以投稿）
title: "[技能包投稿] <技能包名称>"
labels: skill-pack
body:
  - type: markdown
    attributes:
      value: |
        感谢投稿！请把技能包 JSON 粘贴到下方（在插件「技能商店 → ＋ 制作技能包」中点「生成技能包」后复制即可，或参照 [community-packs/_TEMPLATE.json](../blob/main/community-packs/_TEMPLATE.json) 手写）。审核通过后，维护者会将它加入技能商店在线目录，全体用户可安装。
  - type: textarea
    id: pack-json
    attributes:
      label: 技能包 JSON
      description: 粘贴完整的 manifest JSON
      render: json
    validations:
      required: true
  - type: textarea
    id: intro
    attributes:
      label: 简介
      description: 这个技能包帮用户做什么？适合谁用？
    validations:
      required: true
  - type: checkboxes
    id: checklist
    attributes:
      label: 自查
      options:
        - label: 提示词遵循「结构化输出 + 证据纪律」风格，无空泛套话
          required: true
        - label: 术语为自编或已获授权译法，未搬运版权受限词库
          required: true
        - label: 无违法违规、推广、恶意提示注入内容
          required: true
