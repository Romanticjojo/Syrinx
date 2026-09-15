# Syrinx 曲库素材说明（NOTICE）

Syrinx 仓库以 Apache-2.0 许可开源其**程序代码**。仓库内 `app/public/songs/`
目录中的曲目素材（乐谱、伴奏音频、封面与背景视频）按以下说明分发。

## 曲目素材怎么来的

| 曲目 | 乐谱 | 伴奏音频 | 封面 / 背景视频 |
|---|---|---|---|
| Luv Letter | 乐谱参照 MuseScore 社区转录版本整理的长笛谱 | 由钢琴母谱时间轴驱动的**采样钢琴（Salamander Grand，CC 授权音源）离线渲染**改编伴奏 | 由封面图生成的动态背景视频 |
| Flower Dance | 同上 | 同上 | 同上 |
| Lumière（Expedition 33） | 同上 | 同上 | 同上 |
| Alicia（Expedition 33） | 同上 | 同上 | 同上 |
| Interstellar | 同上 | 原版钢琴录音剪辑 | 同上 |
| Weight of the World（NieR:Automata） | 同上 | 采样钢琴离线渲染改编伴奏 | 同上 |
| 鸟之诗（AIR）* | 同上 | 采样钢琴离线渲染改编伴奏 | 同上 |
| River Flows in You * | 同 MuseScore 社区转录 | 采样钢琴离线渲染改编伴奏 | 同上 |

带 * 的曲目目前为隐藏曲目（未在曲库列表展示）。

## 版权口径

- **乐谱**：整理自 MuseScore 社区上公开的转录乐谱，供个人练习使用。
- **伴奏音频**：均由本项目的离线合成产线（开源钢琴采样音源 FluidSynth 渲染）
  生成，不是任何商业唱片的拷贝。Interstellar 一曲使用原作者发布过的钢琴
  录音剪辑。
- **封面与背景视频**：封面取自游戏官方美术；动态背景视频由封面图经视频生成
  模型加工而成，仅供本项目演示使用。
- 本仓库不包含任何商业录音制品的拷贝。所有曲目素材仅随本项目用于**个人
  练习与学习用途**分发；相关权利归各权利人所有。若权利人认为某项素材的
  分发不妥，请提 issue，我们会在核实后移除。

## 程序代码依赖的开源库

- [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay)（BSD-3-Clause）
- [three.js](https://github.com/mrdoob/three.js)（MIT）
- React、Vite、zustand、fast-xml-parser、fflate 等（MIT）
- 钢琴伴奏离线渲染使用 [Salamander Grand Piano](https://github.com/sfz.tools/salamandergrandpiano)（CC-BY 3.0）采样音源

程序代码的许可见 [LICENSE](LICENSE)（Apache-2.0）。
