export const DROP_ONBOARDING_GUIDE = {
  version: "1",
  icon: "🍃",
  title: "欢迎使用苍蓝流笺——拖拽发图与原生文件标签",
  subtitle: "1 分钟了解零侵入拖入文件生成原生标签、无损截图落盘与图库管理（随时点顶栏「? 指南」重看）",
  steps: [
    {
      icon: "⚡",
      navTitle: "连接状态与重注",
      title: "第一步：确认顶栏连接状态为绿色在线",
      desc: "苍蓝流笺通过本地调试通道无侵入增强 Antigravity 主窗口，完全不改 app.asar、不怕客户端更新覆盖。",
      spotlight: {
        selector: "#cdp-pill",
        buttonText: "定位状态指示灯",
        hint: "绿色表示已成功附着到 Antigravity 聊天窗口；若客户端刚重启，点旁边重新注入即可"
      },
      items: [
        {
          icon: "🛡️",
          title: "零 app.asar 侵入，升级免重装",
          text: "不修改 Antigravity 安装目录里的任何原始文件，卸载即零残留。"
        },
        {
          icon: "🔄",
          title: "多窗口自动发现与一键重注",
          text: "页面底部可查看已挂载的所有 Antigravity 窗口，也可随时点顶栏按钮手动重新注入。"
        }
      ],
      tip: "若状态灯提示离线，按上方黄色卡片提示确认 Antigravity 已开启本地调试端口即可。"
    },
    {
      icon: "📎",
      navTitle: "拖放与原生标签",
      title: "拖拽或复制文件直接变成原生 @文件 蓝色标签",
      desc: "从资源管理器拖文件/文件夹进输入框，或按 Ctrl+C / Ctrl+V 粘贴本地文件，立刻生成可点击跳转的原生标签。",
      spotlight: {
        selector: "#mode-mention",
        buttonText: "定位插入模式",
        hint: "推荐使用「原生标签芯片」模式，也可按习惯切换为纯路径文本模式"
      },
      items: [
        {
          icon: "🏷️",
          title: "原生芯片模式 vs 纯路径模式",
          text: "原生芯片美观紧凑且支持点击定位，还能按需勾选同时附带路径文本或自动补尾随空格。"
        },
        {
          icon: "🖱️",
          title: "顶栏面包屑右键菜单增强",
          text: "开启面包屑右键菜单后，在聊天顶部文件路径上点右键就能直接复制路径或在资源管理器定位。"
        }
      ],
      tip: "在输入框里按 Ctrl+V 粘贴剪贴板截图时，也会自动落盘并转为清晰的文件引用。"
    },
    {
      icon: "🖼️",
      navTitle: "无损截图与图库",
      title: "粘贴截图无损 PNG 落盘，消息区支持缩略图灯箱",
      desc: "剪贴板里的图片自动按日期无损保存为 PNG 落盘到本机缓存目录，并在聊天里展示可点击放大的缩略图灯箱。",
      spotlight: {
        selector: "#gallery",
        buttonText: "定位截图图库",
        hint: "这里集中管理近期粘贴落盘的所有截图，支持大图预览、复制路径、在文件夹打开或一键清理"
      },
      items: [
        {
          icon: "✨",
          title: "拒绝压缩糊图，原汁原味无损 PNG",
          text: "高分屏代码报错和 UI 细节截图不再被二次压糊，方便精准排错。"
        },
        {
          icon: "🧹",
          title: "自动定时清理，不占硬盘空间",
          text: "可自定义截图保存目录与自动清理天数，过期缓存自动打扫。"
        }
      ],
      tip: "随时可点顶栏「? 指南」重看本教程；支持键盘 ← / → 翻页与 Esc 关闭。"
    }
  ]
};
