// カメラの一覧と選択
//
// OBS の仮想カメラなども普通のカメラとして見えるので、自動選択ではそれを避ける。
// OBS のブラウザソースで仮想カメラを読み込むと、自分の出力を自分で読み込んでループしてしまう。

export interface CameraInfo {
  deviceId: string;
  label: string;
  virtual: boolean;
}

const VIRTUAL_CAMERA = /virtual|obs|仮想|snap camera|xsplit|manycam|splitcam|nvidia broadcast/i;
const RESOLUTION = { width: { ideal: 1280 }, height: { ideal: 720 } };

export async function listCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label, virtual: VIRTUAL_CAMERA.test(d.label) }));
}

/** 名前が一致するカメラ。なければ仮想カメラ以外の最初のカメラ */
function choose(cams: CameraInfo[], label: string): CameraInfo | undefined {
  const named = label ? (cams.find((c) => c.label === label) ?? cams.find((c) => c.label.includes(label))) : undefined;
  return named ?? cams.find((c) => !c.virtual) ?? cams[0];
}

const open = (deviceId?: string) =>
  navigator.mediaDevices.getUserMedia({
    video: deviceId ? { ...RESOLUTION, deviceId: { exact: deviceId } } : { ...RESOLUTION, facingMode: 'user' },
    audio: false,
  });

/**
 * @param label 使うカメラの名前。空なら自動
 * @returns 開いた映像と、そのカメラの名前
 */
export async function openCamera(label: string): Promise<{ stream: MediaStream; label: string }> {
  // カメラの名前は許可を得るまで空なので、まだなら既定のカメラで開いて許可を得てから選び直す
  const before = await listCameras();
  const known = before.some((c) => c.label);
  const first = known ? choose(before, label) : undefined;
  let stream = await open(first?.deviceId);
  if (first) return { stream, label: first.label };

  const cams = await listCameras();
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
  const want = choose(cams, label);
  if (want && want.deviceId !== current) {
    for (const t of stream.getTracks()) t.stop();
    stream = await open(want.deviceId);
  }
  return { stream, label: want?.label ?? stream.getVideoTracks()[0]?.label ?? '' };
}
