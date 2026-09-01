/** 录音播放的感知响度曲线（t_2264e5ba）
 *  直采录音电平偏低（用户实测：HTMLAudioElement.volume=1 仍偏小声，且其上限就是 1），
 *  回放卡把录音元素接入 WebAudio 增益：满格给 x3（约 +9.5dB）；
 *  平方映射近似等响感知，小音量段调节更细腻。 */
export const REC_GAIN_MAX = 3

/** 滑杆 0-1 → 增益 0..REC_GAIN_MAX（平方感知曲线，输入先钳到 [0,1]） */
export function volToGain(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c * c * REC_GAIN_MAX
}
