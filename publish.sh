cd server
rm -rf node_modules
npm i
npm run build
cd dist
npm publish --access=public --tag=latest