import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages ではリポジトリ名のサブパス（/bust-warp/）に置かれるので、相対パスで出力する
  base: './',
});
