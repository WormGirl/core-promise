import {terser} from 'rollup-plugin-terser';
export default {
  input: 'src/promise.js',
  output: {
    file: 'dist/promise.js',
    format: 'iife',
    exports: 'auto',
    name: 'Promise',
    extend: true,
    plugins: [terser()]
  }
};