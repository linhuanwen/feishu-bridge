import { classifyIntent, type IntentLabel } from "./classifyIntent.js";
import { createOllamaClassifier } from "./createOllamaClassifier.js";

const MODEL = "qwen2.5:7b";
const BASE_URL = "http://127.0.0.1:11434";

const TEST_CASES: Array<{ message: string; expected: IntentLabel }> = [
  // simple: 本地直接执行的操作（35 条）
  { message: "看看桌面", expected: "simple" },
  { message: "查看 C 盘空间", expected: "simple" },
  { message: "截个图", expected: "simple" },
  { message: "打开计算器", expected: "simple" },
  { message: "列出 D 盘有哪些项目", expected: "simple" },
  { message: "现在几点", expected: "simple" },
  { message: "查看系统信息", expected: "simple" },
  { message: "锁屏", expected: "simple" },
  { message: "音量调到 50%", expected: "simple" },
  { message: "播放音乐", expected: "simple" },
  { message: "暂停播放", expected: "simple" },
  { message: "下一首", expected: "simple" },
  { message: "打开微信", expected: "simple" },
  { message: "打开浏览器", expected: "simple" },
  { message: "关闭浏览器", expected: "simple" },
  { message: "查看剪贴板", expected: "simple" },
  { message: "清空回收站", expected: "simple" },
  { message: "打开任务管理器", expected: "simple" },
  { message: "查看运行中的程序", expected: "simple" },
  { message: "重启电脑", expected: "simple" },
  { message: "关机", expected: "simple" },
  { message: "打开文件资源管理器", expected: "simple" },
  { message: "回到桌面", expected: "simple" },
  { message: "显示桌面", expected: "simple" },
  { message: "查看电池状态", expected: "simple" },
  { message: "连接 WiFi", expected: "simple" },
  { message: "断开 WiFi", expected: "simple" },
  { message: "打开系统设置", expected: "simple" },
  { message: "查看网络状态", expected: "simple" },
  { message: "打开记事本", expected: "simple" },
  { message: "打开终端", expected: "simple" },
  { message: "清屏", expected: "simple" },
  { message: "查看当前路径", expected: "simple" },
  { message: "列出当前目录", expected: "simple" },
  { message: "今天几号", expected: "simple" },

  // inquire: 读取/搜索/摘要文件内容（35 条）
  { message: "这个 PDF 写了什么", expected: "inquire" },
  { message: "总结一下这个 Word 文档", expected: "inquire" },
  { message: "读取 d:\\doc.txt 内容", expected: "inquire" },
  { message: "搜索文件中的关键词", expected: "inquire" },
  { message: "这个 Excel 有哪些列", expected: "inquire" },
  { message: "查看这个 Markdown 文件", expected: "inquire" },
  { message: "摘要这篇文章", expected: "inquire" },
  { message: "这个 PPT 讲什么", expected: "inquire" },
  { message: "读取 README.md", expected: "inquire" },
  { message: "这个图片里的文字是什么", expected: "inquire" },
  { message: "搜索代码中的函数", expected: "inquire" },
  { message: "查找日志文件中的错误", expected: "inquire" },
  { message: "这个 CSV 文件有多少行", expected: "inquire" },
  { message: "读取配置文件内容", expected: "inquire" },
  { message: "这个 JSON 文件结构是什么", expected: "inquire" },
  { message: "这个视频字幕说了什么", expected: "inquire" },
  { message: "提取这个文档的关键信息", expected: "inquire" },
  { message: "这个压缩包里有什么文件", expected: "inquire" },
  { message: "查看代码文件内容", expected: "inquire" },
  { message: "这个邮件的主要内容", expected: "inquire" },
  { message: "这个网页保存下来了吗", expected: "inquire" },
  { message: "读取历史记录", expected: "inquire" },
  { message: "查找相似文件", expected: "inquire" },
  { message: "这个数据库表结构", expected: "inquire" },
  { message: "这个音频转文字", expected: "inquire" },
  { message: "这个代码文件是做什么的", expected: "inquire" },
  { message: "这个 txt 文件最后几行", expected: "inquire" },
  { message: "这个 Markdown 的标题", expected: "inquire" },
  { message: "这个 PDF 的目录", expected: "inquire" },
  { message: "这个图片的内容描述", expected: "inquire" },
  { message: "这个日志文件的错误摘要", expected: "inquire" },
  { message: "这个文档有多少页", expected: "inquire" },
  { message: "这个表格的数据", expected: "inquire" },
  { message: "这个代码仓库的 README", expected: "inquire" },
  { message: "这个文件的创建时间", expected: "inquire" },

  // task: 复杂/多轮/修改/审查（30 条）
  { message: "审查 d:\\tool\\远程 的代码", expected: "task" },
  { message: "帮我重构这个函数", expected: "task" },
  { message: "把这个项目改成 TypeScript", expected: "task" },
  { message: "写个脚本批量重命名文件", expected: "task" },
  { message: "帮我修改这个配置文件", expected: "task" },
  { message: "分析代码里的 bug", expected: "task" },
  { message: "给我设计一个数据库 schema", expected: "task" },
  { message: "实现一个简单的 HTTP 服务器", expected: "task" },
  { message: "帮我写单元测试", expected: "task" },
  { message: "把这个函数改成异步的", expected: "task" },
  { message: "优化这段代码的性能", expected: "task" },
  { message: "帮我配置 CI/CD", expected: "task" },
  { message: "给这个类添加注释", expected: "task" },
  { message: "把代码从 Python2 迁移到 Python3", expected: "task" },
  { message: "实现一个排序算法", expected: "task" },
  { message: "帮我做一个网站首页", expected: "task" },
  { message: "设计一个 REST API", expected: "task" },
  { message: "把这个代码模块化", expected: "task" },
  { message: "帮我写一个正则表达式", expected: "task" },
  { message: "分析这个项目的依赖", expected: "task" },
  { message: "帮我配一下 Docker", expected: "task" },
  { message: "写一个爬虫抓取数据", expected: "task" },
  { message: "帮我调试这个错误", expected: "task" },
  { message: "把这个项目部署到服务器", expected: "task" },
  { message: "帮我生成测试数据", expected: "task" },
  { message: "给这个函数添加参数校验", expected: "task" },
  { message: "优化数据库查询", expected: "task" },
  { message: "写一个 GitHub Action", expected: "task" },
  { message: "帮我做代码审查", expected: "task" },
  { message: "实现一个缓存策略", expected: "task" },
];

async function main() {
  console.log(`开始评估 ${MODEL}，共 ${TEST_CASES.length} 条用例...`);

  const callOllama = createOllamaClassifier({ baseUrl: BASE_URL, model: MODEL });
  const results: Array<{ message: string; expected: IntentLabel; actual: IntentLabel; ok: boolean }> = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const { message, expected } = TEST_CASES[i];
    process.stdout.write(`[${i + 1}/${TEST_CASES.length}] ${message.slice(0, 30)}... `);
    const actual = await classifyIntent(message, { callOllama });
    const ok = actual === expected;
    results.push({ message, expected, actual, ok });
    console.log(`${actual} ${ok ? "✓" : "✗"}`);
  }

  const correct = results.filter((r) => r.ok).length;
  const accuracy = correct / results.length;

  console.log("\n=== 评估结果 ===");
  console.log(`总数: ${results.length}`);
  console.log(`正确: ${correct}`);
  console.log(`错误: ${results.length - correct}`);
  console.log(`准确率: ${(accuracy * 100).toFixed(2)}%`);

  if (accuracy < 0.95) {
    console.log("\n未达标（<95%），错误用例：");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  [${r.expected}] -> [${r.actual}] ${r.message}`);
    }
    process.exit(1);
  } else {
    console.log("\n✅ 达到 95% 目标");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
