# Imagen base ligera de Node
FROM node:20-alpine

WORKDIR /app

# Copiamos primero el package.json para aprovechar la cache de Docker:
# si el codigo cambia pero las dependencias no, no reinstala nada.
COPY package.json ./
RUN npm install --omit=dev

# Ahora si, el codigo
COPY index.js ./

EXPOSE 3000
CMD ["node", "index.js"]
