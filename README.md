### Katakana Terminator 片假名终结者 カタカナ‌ターミネーター

#### In a nutshell 简介
A userscript that converts *gairaigo* (Japanese loan words) back to English by appending a parenthetical gloss after katakana on web pages.

这是一个用户脚本：在网页中的日语外来语（片假名）后面用括号标注英文原词。

#### Installation 安装
Please follow the [installation instructions](https://greasyfork.org/en) to configure a userscript manager (Tampermonkey / Violentmonkey / Greasemonkey),
then [click here to install the user script](https://github.com/JohnsonRan/katakana-terminator/raw/master/katakana-terminator.user.js).

请先[阅读教程](https://greasyfork.org/zh-CN)，在浏览器中安装一个用户脚本管理器。之后[戳这里下载并安装本程序](https://github.com/JohnsonRan/katakana-terminator/raw/master/katakana-terminator.user.js)。

#### Features 功能要点
- Parenthetical gloss after katakana: `カタカナ（Katakana）`
- Only annotates currently visible katakana; rescans as you scroll
- Mutation-driven rescans with debouncing (low overhead on dynamic pages)
- Persistent translation cache across pages
- API fallback between Google Translate endpoints
- Menu commands: global toggle, per-site blacklist, clear cache
- Sparse mode on non-Japanese pages until katakana is detected

- 片假名后括号标注：`カタカナ（Katakana）`
- 只处理当前可见的片假名，滚动时再补扫
- 基于 DOM 变动的防抖扫描，降低动态页面开销
- 跨页面持久化翻译缓存
- Google 翻译接口自动回退
- 菜单：总开关、当前网站黑名单、清空缓存
- 非日语页面默认稀疏扫描，发现片假名后再全力工作

#### Limits 已知缺陷
*Gairaigo* from other source languages is also converted to English.

即便一组片假名并非源于英语，也会标注为英语中的对应词汇。

#### Thanks 致谢
Based on the Google Translate API, which was described in [this post](https://github.com/ssut/py-googletrans/issues/268).

Original project by [Arnie97](https://github.com/Arnie97/katakana-terminator).

基于谷歌翻译开发，[API 参考此处](https://github.com/ssut/py-googletrans/issues/268)。原作：[Arnie97](https://github.com/Arnie97/katakana-terminator)。

#### Feedback 反馈
The GitHub issue tracker has been disabled to prevent duplicate comments.
Please report bugs and issues to [the Greasy Fork feedback page](http://greasyfork.org/scripts/33268/feedback).
Check whether you could visit [Google Translate](https://translate.google.com) if the extension does not work on your PC.

为避免两边重复发帖，GitHub Issues 现已关闭，敬请[访问 Greasy Fork 反馈您的问题和建议](https://greasyfork.org/zh-CN/scripts/33268-katakana-terminator/feedback)。
由于众所周知的原因，某些地区有时无法访问[谷歌翻译](https://translate.google.cn)。如果您无法使用此扩展，请先检查能否访问该网站。
