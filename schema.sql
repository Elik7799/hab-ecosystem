--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: friendships; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.friendships (
    id integer NOT NULL,
    user_id_1 integer,
    user_id_2 integer,
    status character varying(20) DEFAULT 'pending'::character varying
);


ALTER TABLE public.friendships OWNER TO CURRENT_USER;

--
-- Name: friendships_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.friendships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.friendships_id_seq OWNER TO CURRENT_USER;

--
-- Name: friendships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.friendships_id_seq OWNED BY public.friendships.id;


--
-- Name: main_movies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.main_movies (
    id integer NOT NULL,
    movie_id integer NOT NULL,
    "position" integer NOT NULL
);


ALTER TABLE public.main_movies OWNER TO CURRENT_USER;

--
-- Name: main_movies_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.main_movies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.main_movies_id_seq OWNER TO CURRENT_USER;

--
-- Name: main_movies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.main_movies_id_seq OWNED BY public.main_movies.id;


--
-- Name: match_movies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.match_movies (
    id integer NOT NULL,
    room_id integer NOT NULL,
    movie_id integer NOT NULL,
    approved boolean,
    round integer DEFAULT 1
);


ALTER TABLE public.match_movies OWNER TO CURRENT_USER;

--
-- Name: match_movies_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.match_movies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.match_movies_id_seq OWNER TO CURRENT_USER;

--
-- Name: match_movies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.match_movies_id_seq OWNED BY public.match_movies.id;


--
-- Name: match_participants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.match_participants (
    id integer NOT NULL,
    room_id integer NOT NULL,
    user_id integer NOT NULL,
    joined boolean DEFAULT false,
    declined boolean DEFAULT false,
    responded boolean DEFAULT false
);


ALTER TABLE public.match_participants OWNER TO CURRENT_USER;

--
-- Name: match_participants_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.match_participants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.match_participants_id_seq OWNER TO CURRENT_USER;

--
-- Name: match_participants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.match_participants_id_seq OWNED BY public.match_participants.id;


--
-- Name: match_rooms; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.match_rooms (
    id integer NOT NULL,
    organizer_id integer NOT NULL,
    criterion character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'waiting'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    cancelled_by integer,
    cancelled_at timestamp without time zone,
    current_round integer DEFAULT 1
);


ALTER TABLE public.match_rooms OWNER TO CURRENT_USER;

--
-- Name: match_rooms_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.match_rooms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.match_rooms_id_seq OWNER TO CURRENT_USER;

--
-- Name: match_rooms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.match_rooms_id_seq OWNED BY public.match_rooms.id;


--
-- Name: match_votes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.match_votes (
    id integer NOT NULL,
    room_id integer NOT NULL,
    movie_id integer NOT NULL,
    user_id integer NOT NULL,
    vote character varying(10) NOT NULL,
    round integer DEFAULT 1
);


ALTER TABLE public.match_votes OWNER TO CURRENT_USER;

--
-- Name: match_votes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.match_votes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.match_votes_id_seq OWNER TO CURRENT_USER;

--
-- Name: match_votes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.match_votes_id_seq OWNED BY public.match_votes.id;


--
-- Name: movie_countries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.movie_countries (
    id integer NOT NULL,
    movie_id integer NOT NULL,
    country character varying(100) NOT NULL
);


ALTER TABLE public.movie_countries OWNER TO CURRENT_USER;

--
-- Name: movie_countries_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.movie_countries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.movie_countries_id_seq OWNER TO CURRENT_USER;

--
-- Name: movie_countries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.movie_countries_id_seq OWNED BY public.movie_countries.id;


--
-- Name: movie_facts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.movie_facts (
    id integer NOT NULL,
    movie_id integer NOT NULL,
    text text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.movie_facts OWNER TO CURRENT_USER;

--
-- Name: movie_facts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.movie_facts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.movie_facts_id_seq OWNER TO CURRENT_USER;

--
-- Name: movie_facts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.movie_facts_id_seq OWNED BY public.movie_facts.id;


--
-- Name: movie_genres; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.movie_genres (
    id integer NOT NULL,
    movie_id integer NOT NULL,
    genre character varying(100) NOT NULL
);


ALTER TABLE public.movie_genres OWNER TO CURRENT_USER;

--
-- Name: movie_genres_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.movie_genres_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.movie_genres_id_seq OWNER TO CURRENT_USER;

--
-- Name: movie_genres_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.movie_genres_id_seq OWNED BY public.movie_genres.id;


--
-- Name: movie_relations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.movie_relations (
    id integer NOT NULL,
    movie_id integer NOT NULL,
    related_movie_id integer NOT NULL,
    relation_type character varying(50) NOT NULL,
    name_ru character varying(255),
    name_en character varying(255),
    name_original character varying(255),
    year integer,
    poster_url text,
    poster_url_preview text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.movie_relations OWNER TO CURRENT_USER;

--
-- Name: movie_relations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.movie_relations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.movie_relations_id_seq OWNER TO CURRENT_USER;

--
-- Name: movie_relations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.movie_relations_id_seq OWNED BY public.movie_relations.id;


--
-- Name: movies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.movies (
    id integer NOT NULL,
    kinopoisk_id integer NOT NULL,
    name_ru character varying(255),
    name_en character varying(255),
    name_original character varying(255),
    year integer,
    type character varying(50),
    poster_url text,
    poster_url_preview text,
    rating_kinopoisk numeric(3,1),
    rating_imdb numeric(3,1),
    description text,
    film_length integer,
    slogan text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.movies OWNER TO CURRENT_USER;

--
-- Name: movies_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.movies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.movies_id_seq OWNER TO CURRENT_USER;

--
-- Name: movies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.movies_id_seq OWNED BY public.movies.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(50) NOT NULL,
    message text NOT NULL,
    link character varying(255),
    read boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.notifications OWNER TO CURRENT_USER;

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_id_seq OWNER TO CURRENT_USER;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: user_movies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_movies (
    id integer NOT NULL,
    user_id integer,
    movie_id integer NOT NULL,
    status character varying(20) DEFAULT 'want_to_watch'::character varying
);


ALTER TABLE public.user_movies OWNER TO CURRENT_USER;

--
-- Name: user_movies_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.user_movies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_movies_id_seq OWNER TO CURRENT_USER;

--
-- Name: user_movies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.user_movies_id_seq OWNED BY public.user_movies.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    email character varying(100) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.users OWNER TO CURRENT_USER;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO CURRENT_USER;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: friendships id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.friendships ALTER COLUMN id SET DEFAULT nextval('public.friendships_id_seq'::regclass);


--
-- Name: main_movies id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.main_movies ALTER COLUMN id SET DEFAULT nextval('public.main_movies_id_seq'::regclass);


--
-- Name: match_movies id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_movies ALTER COLUMN id SET DEFAULT nextval('public.match_movies_id_seq'::regclass);


--
-- Name: match_participants id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_participants ALTER COLUMN id SET DEFAULT nextval('public.match_participants_id_seq'::regclass);


--
-- Name: match_rooms id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_rooms ALTER COLUMN id SET DEFAULT nextval('public.match_rooms_id_seq'::regclass);


--
-- Name: match_votes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_votes ALTER COLUMN id SET DEFAULT nextval('public.match_votes_id_seq'::regclass);


--
-- Name: movie_countries id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_countries ALTER COLUMN id SET DEFAULT nextval('public.movie_countries_id_seq'::regclass);


--
-- Name: movie_facts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_facts ALTER COLUMN id SET DEFAULT nextval('public.movie_facts_id_seq'::regclass);


--
-- Name: movie_genres id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_genres ALTER COLUMN id SET DEFAULT nextval('public.movie_genres_id_seq'::regclass);


--
-- Name: movie_relations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_relations ALTER COLUMN id SET DEFAULT nextval('public.movie_relations_id_seq'::regclass);


--
-- Name: movies id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movies ALTER COLUMN id SET DEFAULT nextval('public.movies_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: user_movies id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_movies ALTER COLUMN id SET DEFAULT nextval('public.user_movies_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_user_id_1_user_id_2_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_id_1_user_id_2_key UNIQUE (user_id_1, user_id_2);


--
-- Name: main_movies main_movies_movie_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.main_movies
    ADD CONSTRAINT main_movies_movie_id_key UNIQUE (movie_id);


--
-- Name: main_movies main_movies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.main_movies
    ADD CONSTRAINT main_movies_pkey PRIMARY KEY (id);


--
-- Name: match_movies match_movies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_movies
    ADD CONSTRAINT match_movies_pkey PRIMARY KEY (id);


--
-- Name: match_movies match_movies_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_movies
    ADD CONSTRAINT match_movies_unique UNIQUE (room_id, movie_id, round);


--
-- Name: match_participants match_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_participants
    ADD CONSTRAINT match_participants_pkey PRIMARY KEY (id);


--
-- Name: match_participants match_participants_room_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_participants
    ADD CONSTRAINT match_participants_room_id_user_id_key UNIQUE (room_id, user_id);


--
-- Name: match_rooms match_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_rooms
    ADD CONSTRAINT match_rooms_pkey PRIMARY KEY (id);


--
-- Name: match_votes match_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_votes
    ADD CONSTRAINT match_votes_pkey PRIMARY KEY (id);


--
-- Name: match_votes match_votes_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_votes
    ADD CONSTRAINT match_votes_unique UNIQUE (room_id, movie_id, user_id, round);


--
-- Name: movie_countries movie_countries_movie_id_country_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_countries
    ADD CONSTRAINT movie_countries_movie_id_country_key UNIQUE (movie_id, country);


--
-- Name: movie_countries movie_countries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_countries
    ADD CONSTRAINT movie_countries_pkey PRIMARY KEY (id);


--
-- Name: movie_facts movie_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_facts
    ADD CONSTRAINT movie_facts_pkey PRIMARY KEY (id);


--
-- Name: movie_genres movie_genres_movie_id_genre_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_genres
    ADD CONSTRAINT movie_genres_movie_id_genre_key UNIQUE (movie_id, genre);


--
-- Name: movie_genres movie_genres_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_genres
    ADD CONSTRAINT movie_genres_pkey PRIMARY KEY (id);


--
-- Name: movie_relations movie_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movie_relations
    ADD CONSTRAINT movie_relations_pkey PRIMARY KEY (id);


--
-- Name: movies movies_kinopoisk_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movies
    ADD CONSTRAINT movies_kinopoisk_id_key UNIQUE (kinopoisk_id);


--
-- Name: movies movies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.movies
    ADD CONSTRAINT movies_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: user_movies user_movies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_movies
    ADD CONSTRAINT user_movies_pkey PRIMARY KEY (id);


--
-- Name: user_movies user_movies_user_id_movie_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_movies
    ADD CONSTRAINT user_movies_user_id_movie_id_key UNIQUE (user_id, movie_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_name_key UNIQUE (name);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_movie_countries_movie; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_movie_countries_movie ON public.movie_countries USING btree (movie_id);


--
-- Name: idx_movie_facts_movie; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_movie_facts_movie ON public.movie_facts USING btree (movie_id);


--
-- Name: idx_movie_genres_movie; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_movie_genres_movie ON public.movie_genres USING btree (movie_id);


--
-- Name: idx_movie_relations_movie; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_movie_relations_movie ON public.movie_relations USING btree (movie_id);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifications_unread ON public.notifications USING btree (user_id, read) WHERE (read = false);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);


--
-- Name: friendships friendships_user_id_1_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_id_1_fkey FOREIGN KEY (user_id_1) REFERENCES public.users(id);


--
-- Name: friendships friendships_user_id_2_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_id_2_fkey FOREIGN KEY (user_id_2) REFERENCES public.users(id);


--
-- Name: main_movies main_movies_movie_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.main_movies
    ADD CONSTRAINT main_movies_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies(id) ON DELETE CASCADE;


--
-- Name: match_movies match_movies_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_movies
    ADD CONSTRAINT match_movies_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.match_rooms(id) ON DELETE CASCADE;


--
-- Name: match_participants match_participants_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_participants
    ADD CONSTRAINT match_participants_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.match_rooms(id) ON DELETE CASCADE;


--
-- Name: match_participants match_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_participants
    ADD CONSTRAINT match_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: match_rooms match_rooms_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_rooms
    ADD CONSTRAINT match_rooms_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id);


--
-- Name: match_rooms match_rooms_organizer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_rooms
    ADD CONSTRAINT match_rooms_organizer_id_fkey FOREIGN KEY (organizer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: match_votes match_votes_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_votes
    ADD CONSTRAINT match_votes_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.match_rooms(id) ON DELETE CASCADE;


--
-- Name: match_votes match_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_votes
    ADD CONSTRAINT match_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_movies user_movies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_movies
    ADD CONSTRAINT user_movies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--