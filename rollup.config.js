import {terser} from 'rollup-plugin-terser';
export default {
  input: 'src/promise.js',
  output: {
    file: 'dist/promise.js',
    format: 'cjs',
    exports: 'auto',
    // format: 'iife',
    // name: 'Promise',
    // extend: true,
    plugins: [terser()]
  }
};