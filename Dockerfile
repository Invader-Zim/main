FROM node:16-alpine

WORKDIR /usr/src/app

# These should be part of docker compose, or passed on the docker run command line
ENV CREDENTIALS_FOLDER=/usr/src/credentials
ENV CURRENT_SEASON=season-23
ENV NUM_WEEKS=10
ENV DATA_FOLDER=/usr/src/data
ENV IFPA_API_KEY=??
ENV LEAGUE_ADMINS=7199,9af5bad1f0900f70b25d6ef8ca8b55b5cf47d6af,58e3994c9c84b18915de0fcec5208d08e4acb3c7
ENV TEST_EMAIL_ADDRESS=??
ENV UPLOADS_FOLDER=/usr/src/data/uploads

ENV EMAIL_HOST=smtp.gmail.com
ENV EMAIL_PORT=587
ENV EMAIL_ADDRESS=seattlemnp.donotreply@gmail.com
ENV EMAIL_NAME=SeattleMNP.DoNotReply
# email password need to be passed on the docker commandline
# ENV EMAIL_PASSWORD=

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 80 443
CMD ["node", "app.js"]

